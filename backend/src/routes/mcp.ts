import { Router, type NextFunction, type Request, type Response } from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { pushToAll } from './push.js'
import { viaCloudflare } from '../middleware/auth.js'
import {
  getProject, getProjectDoc, updateProject,
  addTab, getTab, updateTab, moveTab, removeTab, tabItem,
  pinFile, unpinFile, addReminder, cancelReminder,
  saveAutomation, getAutomation, removeAutomation,
  reportRun, runForSession, setSessionStatus, noteNotify, listEvents, undoEvent,
} from '../lib/projectsStore.js'
import { OFFSET_RULE, localOf } from '../lib/lilkups.js'
import { KEY_RE, LIMITS, ProjError, UUID_RE, type Ctx, type Project, type Reminder, type Tab, type TabItemOp } from '../lib/projectTypes.js'

// The control channel a project's Claude Code sessions use to change the
// project page. Remote-Session.ps1 on thor hands claude an --mcp-config that
// points here with the project in the URL, so a session can only ever reach
// its own project: no tool takes a project id, and nothing here reads another
// project. That is what keeps client-area projects apart from the rest.
//
// Stateless Streamable HTTP: every POST builds a fresh McpServer and transport
// and throws both away when the response closes. The SDK refuses to reuse a
// stateless transport, and there is no session table to leak or expire.
//
// There is no token. Trust is layered: requireAuth's socket check in front of
// this router, then mcpGuard below (thor's tailnet address or loopback only,
// never through Cloudflare, never a browser), then the store, which refuses
// session writes on a project with sessionEdits off and rate-limits the rest.
// Tool arguments are never logged.

const router = Router()

// Matched on the socket peer, never req.ip: with trust proxy on, req.ip comes
// from X-Forwarded-For, which the caller writes.
const MCP_PEERS = (process.env.MCP_PEERS || '100.118.7.57,127.0.0.1,::1').split(',').map((s) => s.trim())

type McpLocals = { project: Project; actor: string; runId: string | null; launchSid: string | null }

function mcpGuard(req: Request, res: Response, next: NextFunction) {
  const peer = (req.socket.remoteAddress || '').replace(/^::ffff:/, '')
  // cloudflared connects from loopback, so the peer list alone would let a
  // Cloudflare request with an app token through. Its headers rule it out.
  if (!MCP_PEERS.includes(peer) || viaCloudflare(req)) {
    return res.status(403).json({ error: 'MCP is for thor sessions only' })
  }
  // Claude Code sends no Origin. A browser always does, which stops a page
  // from driving this endpoint by CSRF or DNS rebinding.
  if (req.headers.origin) return res.status(403).json({ error: 'no browser access' })

  const id = String(req.params.projectId)
  const project = KEY_RE.test(id) ? getProject(id) : null
  if (!project || project.status === 'archived') return res.status(404).json({ error: 'no such project' })

  const sid = String(req.headers['x-valkyrie-session'] ?? '')
  const run = String(req.headers['x-valkyrie-run'] ?? '')
  const locals: McpLocals = {
    project,
    actor: UUID_RE.test(sid) ? 'session:' + sid : 'session:unknown@' + peer,
    // Only a fresh run launch sends the run header. A run conversation
    // resumed from the page sends just its session id, and is found by it.
    runId: UUID_RE.test(run) ? run : UUID_RE.test(sid) ? runForSession(project.id, sid) : null,
    launchSid: UUID_RE.test(sid) ? sid : null,
  }
  Object.assign(res.locals, locals)
  next()
}

// Claude Code puts this in the session's system prompt at every initialize, so
// a rename on the page reaches the next session without touching thor.
function instructionsFor(p: Project): string {
  return `This Claude Code session belongs to the Valkyrie project '${p.name}' (id ${p.id}, area ${p.area}). `
    + `Brendon sees its page at /projects/${p.id} on his phone, browser and desktop app, and it updates live. `
    + 'When he asks to change the project page (tabs, notes, checklists, links, pinned files, reminders, agents, workflows, '
    + 'the project name, summary or next action), use these valkyrie tools. '
    + 'Call project_get first when you need ids or the current layout. '
    + "Replacing a tab title or body needs the tab's current rev as baseRev (from tab_get when project_get marked "
    + 'the tab bodyTruncated); to add text use tab_append. '
    + 'Reminders take inMinutes for a relative time, or at with an explicit UTC offset. Brendon is in America/New_York. '
    + `${OFFSET_RULE} For the current time and offset, run Get-Date -Format o on thor, which is on Eastern time. `
    + (p.allowSnapshots
      ? 'When you pin a file by relPath, read it and pass its text as content (markdown or text, up to 256 KB) so Brendon '
        + 'can open it on his phone. Skip content for binary files and anything holding secrets. To refresh one, pin the '
        + 'same relPath again with new content. '
      : 'File contents are off for this project: pin paths or links only. ')
    + 'Every change is logged with your session id and Brendon can undo it. '
    + 'Never put passwords, API keys or client credentials on the page.'
}

// The SDK also turns a thrown error into an isError result, but with the raw
// message of any error, SQLite's included. Here only store errors reach the
// session word for word; anything else is logged and answered 'internal
// error'. A stale baseRev carries the current tab so the session can merge
// without a second call. A tab too long for that is sent as a header that
// still carries its rev, never as JSON cut mid-body: the cut lost the rev
// (it comes after the body) and handed over a body missing its tail.
const CONFLICT_MAX = 6000

function conflictText(e: ProjError): string {
  if (e.status !== 409 || !e.body?.current) return ''
  const c = e.body.current as Tab
  const full = JSON.stringify(c)
  if (full.length <= CONFLICT_MAX) return ' current: ' + full
  return ' current: ' + JSON.stringify({
    id: c.id, kind: c.kind, title: c.title, rev: c.rev, updatedBy: c.updatedBy, updatedAt: c.updatedAt,
    bodyTruncated: true, note: 'call tab_get for the full body and items',
  })
}

async function toolRun(fn: () => unknown): Promise<CallToolResult> {
  try {
    const result = await fn()
    return { content: [{ type: 'text', text: JSON.stringify(result ?? { ok: true }) }] }
  } catch (e) {
    if (e instanceof ProjError) {
      return { isError: true, content: [{ type: 'text', text: e.message + conflictText(e) }] }
    }
    console.error('[mcp]', (e as Error).message)
    return { isError: true, content: [{ type: 'text', text: 'internal error' }] }
  }
}

const fail = (message: string): never => { throw new ProjError(400, message) }

// project_get answers with the whole page in one call. Long markdown bodies
// would crowd the session's context for no gain, so they are cut here and
// tab_get returns the full text. A cut tab gets rev null: with its real rev, a
// replacement written from the cut text would pass the baseRev check and drop
// everything past the cut.
const PROJECT_GET_BODY = 2000

// 365 days, so inMinutes plus its slack never trips the 366-day cap.
const MAX_IN_MINUTES = 525_600

const withLocal = (r: Reminder) => ({ ...r, atLocal: localOf(r.at) })

function registerTools(server: McpServer, loc: McpLocals): void {
  const id = loc.project.id
  const ctx: Ctx = { actor: loc.actor, via: 'mcp' }
  const text = (max: number) => z.string().max(max)
  const line = (max: number) => z.string().min(1).max(max)

  // ------------------------------------------------------------- read ---

  server.registerTool('project_get', {
    description: 'The project page as JSON: the project, its tabs with their rev (markdown bodies over 2,000 characters '
      + 'are cut, marked bodyTruncated and given rev null; call tab_get for the full text and rev before replacing one), '
      + 'pinned files, agents and workflows, recent runs, linked sessions, reminders and the last change. '
      + 'you holds this session\'s launch session id and run id.',
  }, () => toolRun(async () => {
    const doc = await getProjectDoc(id)
    return {
      ...doc,
      tabs: doc.tabs.map((t) => (t.body.length > PROJECT_GET_BODY
        ? { ...t, body: t.body.slice(0, PROJECT_GET_BODY), bodyTruncated: true, rev: null }
        : t)),
      reminders: doc.reminders.map(withLocal),
      you: { launchSessionId: loc.launchSid, runId: loc.runId },
    }
  }))

  server.registerTool('tab_get', {
    description: 'One tab with its full body, its items and its current rev.',
    inputSchema: { tabId: z.string() },
  }, ({ tabId }) => toolRun(() => getTab(id, tabId)))

  server.registerTool('automation_get', {
    description: 'One agent or workflow with its full body.',
    inputSchema: { key: z.string() },
  }, ({ key }) => toolRun(() => getAutomation(id, key)))

  server.registerTool('reminder_list', {
    description: 'Pending reminders by time, then the sent, failed and canceled ones from the last 30 days. '
      + 'at is UTC; atLocal is the same time in New York.',
  }, () => toolRun(async () => (await getProjectDoc(id)).reminders.map(withLocal)))

  server.registerTool('history', {
    description: 'Recent changes to the project, newest first, with event ids, who made each one and whether it can be undone.',
    inputSchema: { limit: z.number().int().min(1).max(50).optional() },
  }, ({ limit }) => toolRun(() => listEvents(id, { limit: limit ?? 20 })))

  // ---------------------------------------------------------- project ---

  server.registerTool('project_update', {
    description: 'Change the project name, summary, next action or status. Pass only the fields to change.',
    inputSchema: {
      name: line(LIMITS.projectName).optional(),
      summary: text(LIMITS.summary).optional(),
      nextAction: text(LIMITS.nextAction).optional(),
      status: z.enum(['active', 'paused']).optional(),
    },
  }, ({ name, summary, nextAction, status }) => toolRun(() => updateProject(id, defined({ name, summary, nextAction, status }), ctx)))

  // ------------------------------------------------------------- tabs ---

  server.registerTool('tab_add', {
    description: 'Add a tab. markdown takes body. checklist takes items as strings. links takes items as {label, url}. '
      + 'position is start or end (the default).',
    inputSchema: {
      kind: z.enum(['markdown', 'checklist', 'links']),
      title: line(LIMITS.tabTitle),
      body: text(LIMITS.tabBody).optional(),
      items: z.union([
        z.array(text(LIMITS.checklistText)).max(LIMITS.itemsPerTab),
        z.array(z.object({ label: line(LIMITS.linkLabel), url: text(LIMITS.url) })).max(LIMITS.itemsPerTab),
      ]).optional(),
      position: z.enum(['start', 'end']).optional(),
    },
  }, ({ kind, title, body, items, position }) => toolRun(() => addTab(id, defined({ kind, title, body, items, position }), ctx)))

  // baseRev is required here although the store takes it as optional: every
  // MCP caller is a session, and the store refuses a session's replacement
  // without one. Optional in the schema only cost each first call a retry.
  server.registerTool('tab_update', {
    description: 'Replace a tab title or markdown body. Pass baseRev, the tab rev from tab_get (project_get gives a cut '
      + 'tab rev null). If the tab changed since, this fails with the current tab: merge and retry with its rev. '
      + 'To add text use tab_append.',
    inputSchema: {
      tabId: z.string(),
      baseRev: z.number().int(),
      title: line(LIMITS.tabTitle).optional(),
      body: text(LIMITS.tabBody).optional(),
    },
  }, ({ tabId, baseRev, title, body }) => toolRun(() => updateTab(id, tabId, defined({ baseRev, title, body }), ctx)))

  server.registerTool('tab_append', {
    description: 'Add text to a tab without replacing it. markdown: appends a blank line and the text. '
      + 'checklist: each non-empty line becomes an item. links tabs refuse it.',
    inputSchema: { tabId: z.string(), text: line(LIMITS.appendText) },
  }, ({ tabId, text: appendBody }) => toolRun(() => updateTab(id, tabId, { appendBody }, ctx)))

  server.registerTool('tab_move', {
    description: 'Move a tab to a position among the tabs. 0 is first.',
    inputSchema: { tabId: z.string(), toIndex: z.number().int().min(0) },
  }, ({ tabId, toIndex }) => toolRun(() => moveTab(id, tabId, toIndex, ctx)))

  server.registerTool('tab_remove', {
    description: 'Remove a tab. Brendon can undo it.',
    inputSchema: { tabId: z.string() },
  }, ({ tabId }) => toolRun(() => removeTab(id, tabId, ctx)))

  server.registerTool('tab_item', {
    description: 'Change one item in a checklist or links tab. checklist: add takes text; set takes itemId and done; '
      + 'edit takes itemId and text. links: add takes label and url; edit takes itemId, label and url. remove takes itemId.',
    inputSchema: {
      tabId: z.string(),
      op: z.enum(['add', 'set', 'edit', 'remove']),
      itemId: z.string().optional(),
      text: text(LIMITS.checklistText).optional(),
      done: z.boolean().optional(),
      label: text(LIMITS.linkLabel).optional(),
      url: text(LIMITS.url).optional(),
    },
  }, (a) => toolRun(() => {
    let op: TabItemOp
    if (a.op === 'add') {
      op = defined({ op: a.op, text: a.text, label: a.label, url: a.url })
    } else {
      const itemId = a.itemId ?? fail(`${a.op} needs itemId`)
      if (a.op === 'set') op = { op: a.op, itemId, done: a.done ?? fail('set needs done') }
      else if (a.op === 'edit') op = defined({ op: a.op, itemId, text: a.text, label: a.label, url: a.url })
      else op = { op: a.op, itemId }
    }
    return tabItem(id, a.tabId, op, ctx)
  }))

  // ------------------------------------------------------------ files ---

  server.registerTool('file_pin', {
    description: 'Pin a file to the project page. relPath pins a path relative to the project folder (no drive, no leading '
      + 'slash, no ..); pinning the same relPath again updates that pin. url pins a link. With neither, it pins a doc, '
      + 'which needs content. content (markdown or text) is a snapshot Brendon can read on his phone: pinning a path '
      + 'with content is what gives him a view button there. Projects with file contents off refuse it.',
    inputSchema: {
      label: line(LIMITS.fileLabel),
      relPath: text(LIMITS.relPath).optional(),
      url: text(LIMITS.url).optional(),
      note: text(LIMITS.fileNote).optional(),
      content: text(LIMITS.fileContent).optional(),
      contentType: z.enum(['markdown', 'text']).optional(),
    },
  }, ({ label, relPath, url, note, content, contentType }) => toolRun(() => {
    if (relPath !== undefined && url !== undefined) fail('pass relPath or url, not both')
    const kind = url !== undefined ? 'url' : relPath !== undefined ? 'path' : 'doc'
    return pinFile(id, defined({ kind, label, relPath, url, note, content, contentType }), ctx)
  }))

  server.registerTool('file_unpin', {
    description: 'Unpin a file. Brendon can undo it.',
    inputSchema: { fileId: z.string() },
  }, ({ fileId }) => toolRun(() => unpinFile(id, fileId, ctx)))

  // -------------------------------------------------------- reminders ---

  server.registerTool('reminder_add', {
    description: 'Schedule a one-time reminder for Brendon. Pass exactly one of inMinutes (a relative time, counted '
      + 'on odin) or at (ISO 8601 with Z or an explicit offset, at least a minute ahead and at most 366 days out). '
      + `Brendon is in America/New_York. ${OFFSET_RULE} The result's atLocal is the time in New York: check it says `
      + 'the hour he asked for.',
    inputSchema: {
      at: z.string().optional(),
      inMinutes: z.number().int().min(1).max(MAX_IN_MINUTES).optional(),
      message: line(LIMITS.reminderMessage),
    },
  }, ({ at, inMinutes, message }) => toolRun(async () => {
    if ((at === undefined) === (inMinutes === undefined)) fail('pass exactly one of at or inMinutes')
    // A few seconds of slack: lilkups fires on a minute timer, and without it
    // "in 1 minute" would land just inside the one-minute minimum.
    const when = at ?? new Date(Date.now() + (inMinutes as number) * 60_000 + 5_000).toISOString()
    return withLocal(await addReminder(id, { at: when, message }, ctx))
  }))

  server.registerTool('reminder_cancel', {
    description: 'Cancel a pending reminder.',
    inputSchema: { reminderId: z.string() },
  }, ({ reminderId }) => toolRun(() => cancelReminder(id, reminderId, ctx)))

  // ---------------------------------------------- agents and workflows ---

  server.registerTool('automation_save', {
    description: 'Create or replace an agent or workflow on the project page, by key. An agent body is the brief a run '
      + 'follows; a workflow body is markdown steps. model is empty for the default, or opus, sonnet or haiku. '
      + 'Sessions cannot start runs: Brendon starts them from the page.',
    inputSchema: {
      kind: z.enum(['agent', 'workflow']),
      key: z.string().regex(KEY_RE),
      name: line(LIMITS.automationName),
      description: text(LIMITS.automationDescription).optional(),
      body: line(LIMITS.automationBody),
      model: z.enum(['', 'opus', 'sonnet', 'haiku']).optional(),
    },
  }, ({ kind, key, name, description, body, model }) => toolRun(() => ({
    ...saveAutomation(id, key, defined({ kind, name, description, body, model }), ctx),
    note: 'Brendon starts runs from the project page.',
  })))

  server.registerTool('automation_remove', {
    description: 'Remove an agent or workflow. Brendon can undo it.',
    inputSchema: { key: z.string() },
  }, ({ key }) => toolRun(() => removeAutomation(id, key, ctx)))

  // ------------------------------------------------ runs and sessions ---

  server.registerTool('run_report', {
    description: 'Report how this agent or workflow run ended: done, failed or blocked, with a short summary. '
      + 'Only a session started as a run can call it.',
    inputSchema: { status: z.enum(['done', 'failed', 'blocked']), summary: text(LIMITS.runSummary) },
  }, ({ status, summary }) => toolRun(() => {
    const runId = loc.runId ?? fail('this session is not an agent or workflow run')
    return reportRun(id, runId, status, summary, ctx)
  }))

  server.registerTool('session_status', {
    description: 'Set the one-line status shown for this session on the project page. An empty note clears it.',
    inputSchema: { note: text(LIMITS.sessionNote) },
  }, ({ note }) => toolRun(() => {
    const sid = loc.launchSid ?? fail('this session was not started from the project page, so it has no status line')
    return { updated: setSessionStatus(id, sid, note, ctx) }
  }))

  // ------------------------------------------------------------ other ---

  server.registerTool('notify', {
    description: 'Send Brendon a push notification that opens this project page. At most 5 per 10 minutes, so keep it '
      + 'for something he needs to see now.',
    inputSchema: { title: line(80), body: line(300) },
  }, ({ title, body }) => toolRun(async () => {
    noteNotify(id, ctx, title)
    const r = await pushToAll({ title, body, tag: 'proj-' + id, url: '/projects/' + id })
    return { sent: r.sent }
  }))

  server.registerTool('undo', {
    description: 'Undo one of your own changes by its event id from history.',
    inputSchema: { eventId: z.number().int() },
  }, ({ eventId }) => toolRun(() => undoEvent(id, eventId, { onlyActor: loc.actor }, ctx)))
}

// The store reads "key present" as "change it", so a field the session left
// out must not arrive as an undefined-valued key.
function defined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}

router.post('/mcp/:projectId', mcpGuard, async (req, res) => {
  const loc = res.locals as McpLocals
  try {
    const server = new McpServer({ name: 'valkyrie', version: '1.0.0' }, { instructions: instructionsFor(loc.project) })
    registerTools(server, loc)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    // express.json has already read the stream, so the parsed body must be
    // handed over or the transport would wait on a body that never comes.
    await transport.handleRequest(req, res, req.body)
  } catch (e) {
    console.error('[mcp]', (e as Error).message)
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null })
    }
  }
})

// Stateless: no server-to-client stream to open and no session to delete.
const notAllowed = (_req: Request, res: Response) => {
  res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null })
}
router.get('/mcp/:projectId', notAllowed)
router.delete('/mcp/:projectId', notAllowed)

export default router
