import { execFile } from 'node:child_process'
import { Router, type NextFunction, type Request, type Response } from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { viaCloudflare } from '../middleware/auth.js'
import {
  AgentError, getAgent, getChannel, getMail, listChannels, listMail, listMessages, listTeams, listTracked, mailInConversation,
  patchAgent, routeMail, setMailState, trackedTicket, trackNote, type Agent, type Channel, type Ref,
} from '../lib/agentsStore.js'
import { agentPost, canPost, dmChannel, etLabel, runForToken, type RunCtx } from '../lib/agents.js'
import { proposeMailReply, proposeTicketCreate, proposeTicketNote, proposeTicketUpdate } from '../lib/agentActions.js'
import {
  contactsByEmail, findCompanies, franchiseLabel, getTicket, labels, PsaError, searchTickets, ticketNotes, type Franchise,
} from '../lib/psa.js'
import { getProject, getProjectDoc, getTab, tabItem, updateProject, updateTab } from '../lib/projectsStore.js'
import { addTask } from '../lib/tasksStore.js'
import { ProjError, type Ctx } from '../lib/projectTypes.js'
import { franchiseConf } from '../lib/workConfig.js'

// The tools a work agent acts with (lib/agents.ts starts each run with an
// --mcp-config naming this endpoint and the run's token). Loopback only: the
// runs are claude processes on odin itself. The token says which agent is
// calling, and every tool is limited to that agent's kind and franchise:
// one franchise's triage never reads another's tickets, a personal project's agent never
// reads work mail. Outward-facing work only ever becomes a proposal.

const router = Router()

type Loc = { agent: Agent; run: RunCtx }

function guard(req: Request, res: Response, next: NextFunction) {
  const peer = (req.socket.remoteAddress || '').replace(/^::ffff:/, '')
  if (!['127.0.0.1', '::1'].includes(peer) || viaCloudflare(req) || req.headers.origin) {
    return res.status(403).json({ error: 'agent tools are for agent runs on this host only' })
  }
  const run = runForToken(String(req.headers['x-agent-token'] ?? ''))
  const agent = run ? getAgent(run.agentId) : null
  if (!run || !agent) return res.status(401).json({ error: 'no such run' })
  Object.assign(res.locals, { agent, run } satisfies Loc)
  next()
}

async function toolRun(fn: () => unknown): Promise<CallToolResult> {
  try {
    const result = await fn()
    return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result ?? { ok: true }) }] }
  } catch (e) {
    if (e instanceof AgentError || e instanceof PsaError || e instanceof ProjError) {
      return { isError: true, content: [{ type: 'text', text: e.message }] }
    }
    console.error('[agent-mcp]', (e as Error).message)
    return { isError: true, content: [{ type: 'text', text: 'internal error' }] }
  }
}

const FILES_URL = process.env.PROJECT_FILES_URL || 'http://100.118.7.57:8767'
const FILES_TOKEN = process.env.PROJECT_FILES_TOKEN || ''

async function thorFile(kind: 'tree' | 'file', target: string, rel: string): Promise<globalThis.Response> {
  if (!FILES_TOKEN) throw new AgentError(503, 'the project file service is not configured on odin')
  const q = new URLSearchParams({ target, rel })
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 15_000)
  try {
    const r = await fetch(`${FILES_URL}/${kind}?${q}`, { headers: { Authorization: `Bearer ${FILES_TOKEN}` }, signal: ac.signal })
    if (!r.ok) {
      let msg = `thor answered ${r.status}`
      try { msg = ((await r.json()) as { error?: string }).error || msg } catch { /* not json */ }
      throw new AgentError(r.status === 404 ? 404 : 502, msg)
    }
    return r
  } catch (e) {
    if (e instanceof AgentError) throw e
    throw new AgentError(502, 'thor is not answering (it can be off or asleep)')
  } finally {
    clearTimeout(timer)
  }
}

const brief = (t: { body: string }) => (t.body.length > 1500 ? { ...t, body: `${t.body.slice(0, 1500)}…`, bodyTruncated: true } : t)

function canRead(agent: Agent, ch: Channel): boolean {
  return canPost(agent, ch) || (ch.kind === 'home' && getAgent(ch.agentIds[0] ?? '')?.area === agent.area)
}

function register(server: McpServer, loc: Loc): void {
  const { agent, run } = loc
  const acted = <T>(v: T): T => { run.acted++; return v }
  const ctx: Ctx = { actor: `agent:${agent.id}`, via: 'mcp' }
  const f = agent.franchise as Franchise | null
  const refSchema = z.array(z.union([
    z.object({ type: z.literal('ticket'), id: z.number().int(), number: z.string().max(20), title: z.string().max(200).optional() }),
    z.object({ type: z.literal('mail'), n: z.number().int() }),
    z.object({ type: z.literal('link'), url: z.string().url().max(2000), label: z.string().max(80).optional() }),
  ])).max(10).optional()

  const toRefs = (refs: z.infer<NonNullable<typeof refSchema>> | undefined): Ref[] => (refs ?? []).flatMap((r): Ref[] => {
    if (r.type === 'ticket') return f ? [{ type: 'ticket', franchise: f, id: r.id, number: r.number, title: r.title }] : []
    if (r.type === 'mail') {
      const m = getMail(r.n)
      return m ? [{ type: 'mail', n: m.n, subject: m.subject, from: m.fromName || m.fromAddress, url: m.webLink ?? undefined }] : []
    }
    return /^https:\/\//.test(r.url) ? [{ type: 'link', url: r.url, label: r.label }] : []
  })

  // ------------------------------------------------------- everyone ---

  server.registerTool('team', {
    description: 'The other agents (id, name, area, role, status) and the channels you can post in.',
    inputSchema: {},
  }, () => toolRun(() => ({
    agents: [...new Set(listChannels().flatMap((c) => c.agentIds))].map((id) => getAgent(id)).filter((a): a is Agent => Boolean(a?.enabled))
      .map((a) => ({ id: a.id, name: a.name, area: a.area, role: a.role, status: a.status })),
    channels: listChannels().filter((c) => canPost(agent, c)).map((c) => ({ id: c.id, name: c.name, kind: c.kind })),
  })))

  server.registerTool('read_channel', {
    description: 'Messages in a channel, oldest first. Defaults to your own channel. before pages back by message id.',
    inputSchema: { channel: z.string().max(80).optional(), limit: z.number().int().min(1).max(80).optional(), before: z.number().int().optional() },
  }, (a) => toolRun(() => {
    const ch = getChannel(a.channel ?? agent.channelId)
    if (!ch || !canRead(agent, ch)) throw new AgentError(404, `no channel ${a.channel} you can read`)
    return listMessages(ch.id, { limit: a.limit ?? 30, before: a.before }).map((m) => ({
      id: m.id, at: etLabel(m.createdAt), from: m.author, text: m.text, proposal: m.proposalId ?? undefined,
    }))
  }))

  server.registerTool('post', {
    description: 'Post a message. channel defaults to your own. Mention a teammate with @id to wake them; @brendon or notify:true buzzes '
      + "Brendon's phone (only when you need him). refs attach tickets (your franchise), mail by number, or https links.",
    inputSchema: { text: z.string().min(1).max(6000), channel: z.string().max(80).optional(), notify: z.boolean().optional(), refs: refSchema },
  }, (a) => toolRun(() => {
    const m = agentPost(agent, a.channel ?? agent.channelId, a.text, { notify: a.notify, refs: toRefs(a.refs), hop: run.hop })
    return acted({ posted: m.id, channel: m.channelId })
  }))

  server.registerTool('dm', {
    description: 'A direct message to another agent, in a DM channel Brendon can read. It wakes them. Hand work over with the mail or '
      + 'ticket number only, never another area\'s client details.',
    inputSchema: { agent: z.string().max(60), text: z.string().min(1).max(3000) },
  }, (a) => toolRun(() => {
    const other = getAgent(a.agent.replace(/^@/, ''))
    if (!other?.enabled || other.id === agent.id) throw new AgentError(404, `no teammate ${a.agent}`)
    const ch = dmChannel(agent, other)
    const m = agentPost(agent, ch.id, a.text, { hop: run.hop })
    return acted({ posted: m.id, channel: ch.id })
  }))

  server.registerTool('notebook_set', {
    description: 'Replace your notebook (your memory between runs) with this text. Keep it under about 2,500 words.',
    inputSchema: { text: z.string().max(20_000) },
  }, (a) => toolRun(() => { patchAgent(agent.id, { notebook: a.text }); return acted({ ok: true, chars: a.text.length }) }))

  server.registerTool('task_add', {
    description: "Add a task to Brendon's task list. due is New York time, YYYY-MM-DD or YYYY-MM-DDTHH:mm."
      + (agent.projectId ? ' It goes on your project.' : ` It goes under the ${agent.area} area.`),
    inputSchema: { text: z.string().min(1).max(300), due: z.string().max(16).optional() },
  }, (a) => toolRun(() => acted(addTask(agent.projectId
    ? { text: a.text, due: a.due, projectId: agent.projectId }
    : { text: a.text, due: a.due, area: agent.area }, ctx, false))))

  // ---------------------------------------------------- work, reads ---


  const triage = agent.kind === 'triage'

  if (f) {
    server.registerTool('ticket', {
      description: `One ${franchiseLabel(f)} ticket, live from Autotask, by id or number (T20261029.0001), with its newest notes and your tracker note.`,
      inputSchema: { ticket: z.string().max(20), notes: z.number().int().min(0).max(30).optional() },
    }, (a) => toolRun(async () => {
      const t = await getTicket(f, a.ticket)
      const notes = a.notes === 0 ? [] : await ticketNotes(f, t.id, a.notes ?? 12)
      const tr = trackedTicket(f, t.id)
      return {
        ...t, created: etLabel(t.created), lastActivity: etLabel(t.lastActivity), due: etLabel(t.due),
        notes: notes.map((n) => ({ ...n, at: etLabel(n.at) })),
        tracker: tr ? { summary: tr.summary, next: tr.next, needsBrendon: tr.needsBrendon, waitingOn: tr.waitingOn } : null,
      }
    }))

    server.registerTool('ticket_search', {
      description: `Search ${franchiseLabel(f)} Autotask tickets by title words and/or company id. Open only unless includeClosed. days looks back from today (default 120).`,
      inputSchema: { text: z.string().max(100).optional(), companyId: z.number().int().optional(), includeClosed: z.boolean().optional(), days: z.number().int().min(1).max(730).optional() },
    }, (a) => toolRun(async () => (await searchTickets(f, a)).map((t) => ({
      id: t.id, number: t.number, title: t.title, company: t.company, status: t.status, priority: t.priority,
      assignee: t.assignee, created: etLabel(t.created), lastActivity: etLabel(t.lastActivity),
    }))))

    server.registerTool('mail_get', {
      description: 'One work mail by its number: sender, recipients, subject, the text, attachments by name, and who it is routed to.',
      inputSchema: { n: z.number().int() },
    }, (a) => toolRun(() => {
      const m = getMail(a.n)
      if (!m) throw new AgentError(404, `no mail #${a.n}`)
      if (!triage && m.franchise !== f) throw new AgentError(403, `mail #${a.n} is not ${franchiseLabel(f)}'s`)
      return {
        n: m.n, mailbox: m.address, from: `${m.fromName} <${m.fromAddress}>`, to: m.toList, cc: m.ccList, subject: m.subject,
        received: etLabel(m.receivedAt), importance: m.importance, focusedInbox: m.focused, attachments: m.attachments || undefined,
        routedTo: m.franchise ? franchiseLabel(m.franchise) : 'nobody', state: m.state, outcome: m.outcome || undefined, body: m.body,
      }
    }))
  }

  if (triage && f) {
    server.registerTool('tickets', {
      description: `The tracker: open ${franchiseLabel(f)} tickets (outside Monitoring Alert), needing Brendon first, then by latest activity.`,
      inputSchema: { mine: z.boolean().optional(), needsBrendon: z.boolean().optional(), companyId: z.number().int().optional(), includeClosed: z.boolean().optional(), limit: z.number().int().min(1).max(300).optional() },
    }, (a) => toolRun(() => listTracked(f, { open: !a.includeClosed, mine: a.mine, needsBrendon: a.needsBrendon, companyId: a.companyId, limit: a.limit ?? 120 }).map((t) => ({
      id: t.id, number: t.number, title: t.title, company: t.company, companyId: t.companyId, status: t.status, priority: t.priority,
      queue: t.queue, assignee: t.assignee, lastActivity: etLabel(t.lastActivity), due: etLabel(t.due),
      summary: t.summary || undefined, next: t.next || undefined, needsBrendon: t.needsBrendon || undefined, waitingOn: t.waitingOn || undefined,
      closed: t.closedAt ? etLabel(t.closedAt) : undefined,
    }))))

    server.registerTool('track', {
      description: 'Your note on a tracked ticket: summary (one line), next step, needsBrendon, waitingOn (client, vendor, Brendon, Ido...). Pass only what changes.',
      inputSchema: { ticketId: z.number().int(), summary: z.string().max(600).optional(), next: z.string().max(300).optional(), needsBrendon: z.boolean().optional(), waitingOn: z.string().max(120).optional() },
    }, (a) => toolRun(() => {
      const t = trackNote(f, a.ticketId, a)
      return acted({ number: t.number, summary: t.summary, next: t.next, needsBrendon: t.needsBrendon, waitingOn: t.waitingOn })
    }))

    server.registerTool('company_find', {
      description: `${franchiseLabel(f)} Autotask companies whose name contains the text (a distinctive fragment works best).`,
      inputSchema: { name: z.string().min(2).max(80) },
    }, (a) => toolRun(() => findCompanies(f, a.name)))

    server.registerTool('contact_find', {
      description: `${franchiseLabel(f)} Autotask contacts with this email address, with their company.`,
      inputSchema: { email: z.string().email().max(200) },
    }, (a) => toolRun(() => contactsByEmail(f, a.email)))

    server.registerTool('autotask_labels', {
      description: `The ${franchiseLabel(f)} Autotask status, priority and queue names, for proposals.`,
      inputSchema: {},
    }, () => toolRun(() => labels(f)))

    server.registerTool('mail_list', {
      description: 'Recent work mail routed to you (state new, handled, ignored or needs-brendon), newest first, without bodies.',
      inputSchema: { state: z.enum(['new', 'handled', 'ignored', 'needs-brendon']).optional(), days: z.number().int().min(1).max(30).optional(), all: z.boolean().optional().describe('every routed work mail, every franchise') },
    }, (a) => toolRun(() => listMail({ agentId: a.all ? undefined : agent.id, state: a.state, days: a.days ?? 3 }).map((m) => ({
      n: m.n, from: `${m.fromName} <${m.fromAddress}>`, subject: m.subject, received: etLabel(m.receivedAt), state: m.state,
      outcome: m.outcome || undefined, routedTo: m.franchise ?? undefined,
    }))))

    server.registerTool('mail_thread', {
      description: 'Other mail Valkyrie holds from the same conversation as this one, newest first.',
      inputSchema: { n: z.number().int() },
    }, (a) => toolRun(() => {
      const m = getMail(a.n)
      if (!m) throw new AgentError(404, `no mail #${a.n}`)
      return mailInConversation(m.conversationId, 12).filter((x) => x.n !== m.n).map((x) => ({
        n: x.n, from: `${x.fromName} <${x.fromAddress}>`, received: etLabel(x.receivedAt), subject: x.subject, preview: x.body.slice(0, 400),
      }))
    }))

    server.registerTool('mail_take', {
      description: 'Take a mail another triage agent handed you, so it is yours to reply to and track.',
      inputSchema: { n: z.number().int() },
    }, (a) => toolRun(() => {
      const m = getMail(a.n)
      if (!m) throw new AgentError(404, `no mail #${a.n}`)
      routeMail(m.n, f, agent.id, 'new', '')
      return acted({ n: m.n, routedTo: franchiseLabel(f) })
    }))

    server.registerTool('mail_done', {
      description: 'File a mail: handled (dealt with or tracked), ignored (nothing to do), or needs-brendon (waiting on him). outcome is one short line.',
      inputSchema: { n: z.number().int(), state: z.enum(['handled', 'ignored', 'needs-brendon']), outcome: z.string().min(1).max(300) },
    }, (a) => toolRun(() => {
      const m = setMailState(a.n, agent.id, a.state, a.outcome)
      return acted({ n: m.n, state: m.state })
    }))

    if (franchiseConf(f)?.teams) {
      server.registerTool('teams_list', {
        description: 'Recent Teams messages from the internal tenant (Brendon\'s chats), newest first.',
        inputSchema: { days: z.number().int().min(1).max(14).optional() },
      }, (a) => toolRun(() => listTeams(a.days ?? 2).map((t) => ({ chat: t.chatTopic, from: t.fromName, at: etLabel(t.createdAt), text: t.text }))))
    }

    // ------------------------------------------------- proposals ---

    server.registerTool('propose_mail_reply', {
      description: 'Propose a reply to a mail, for Brendon to approve, edit or decline. It replies in the sender\'s own thread. '
        + `cc defaults to ${franchiseConf(f)?.supportCc || 'nobody'}; replyAll keeps everyone on the thread instead. `
        + 'body is the plain-text draft from "Hi <name>," to the last sentence, with no sign-off and no signature. note tells Brendon anything he must check.',
      inputSchema: { n: z.number().int(), body: z.string().min(10).max(8000), replyAll: z.boolean().optional(), cc: z.array(z.string().max(200)).max(6).optional(), note: z.string().max(600).optional() },
    }, (a) => toolRun(() => { const p = proposeMailReply(agent, a, run.hop); return acted({ proposal: p.id, status: p.status }) }))

    server.registerTool('propose_ticket_note', {
      description: 'Propose an internal note (techs only, never the client) on a ticket.',
      inputSchema: { ticketId: z.number().int(), number: z.string().max(20).optional(), title: z.string().min(1).max(250), text: z.string().min(1).max(8000), why: z.string().max(400).optional() },
    }, (a) => toolRun(() => { const p = proposeTicketNote(agent, a, run.hop); return acted({ proposal: p.id }) }))

    server.registerTool('propose_ticket_update', {
      description: 'Propose a ticket change: status or priority by name (autotask_labels), assign to Brendon, a due time. Complete emails the contact the resolution.',
      inputSchema: {
        ticketId: z.number().int(), number: z.string().max(20).optional(), status: z.string().max(40).optional(), priority: z.string().max(20).optional(),
        assignToBrendon: z.boolean().optional(), due: z.string().max(30).optional(), why: z.string().min(1).max(400),
      },
    }, (a) => toolRun(() => { const p = proposeTicketUpdate(agent, a, run.hop); return acted({ proposal: p.id }) }))

    server.registerTool('propose_ticket_create', {
      description: 'Propose a new ticket, assigned to Brendon. With contactId Autotask emails that contact; without it the ticket is internal. n links the mail it came from.',
      inputSchema: {
        companyId: z.number().int(), company: z.string().max(120), title: z.string().min(3).max(255), description: z.string().min(1).max(8000),
        priority: z.string().max(20).optional(), queue: z.string().max(40).optional(), contactId: z.number().int().optional(), contact: z.string().max(120).optional(),
        n: z.number().int().optional(), why: z.string().max(400).optional(),
      },
    }, (a) => toolRun(() => { const p = proposeTicketCreate(agent, a, run.hop); return acted({ proposal: p.id }) }))
  }

  // -------------------------------------------------------- project ---

  if (agent.kind === 'project' && agent.projectId) {
    const pid = agent.projectId
    server.registerTool('project_get', {
      description: 'Your project page: summary, next action, tabs (long bodies cut, use tab_get), tasks, pinned files, linked sessions, reminders.',
      inputSchema: {},
    }, () => toolRun(async () => {
      const doc = await getProjectDoc(pid)
      return {
        project: doc.project, tabs: doc.tabs.map(brief), files: doc.files.map((x) => ({ id: x.id, label: x.label, relPath: x.relPath, url: x.url, note: x.note })),
        sessions: doc.sessions.slice(0, 8), reminders: doc.reminders.slice(0, 8), lastEvent: doc.lastEvent,
      }
    }))

    server.registerTool('tab_get', {
      description: 'One tab of your project with its full body and items.',
      inputSchema: { tabId: z.string().max(40) },
    }, (a) => toolRun(() => getTab(pid, a.tabId)))

    server.registerTool('project_update', {
      description: 'Set the project summary and/or next action.',
      inputSchema: { summary: z.string().max(500).optional(), nextAction: z.string().max(140).optional() },
    }, (a) => toolRun(() => acted(updateProject(pid, Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)), ctx))))

    server.registerTool('tab_append', {
      description: 'Add text to a tab: markdown gets a new paragraph, a checklist gets one item per line.',
      inputSchema: { tabId: z.string().max(40), text: z.string().min(1).max(4000) },
    }, (a) => toolRun(() => acted(updateTab(pid, a.tabId, { appendBody: a.text }, ctx))))

    server.registerTool('task_check', {
      description: 'Check or uncheck a task (a checklist item) on your project.',
      inputSchema: { tabId: z.string().max(40), itemId: z.string().max(40), done: z.boolean() },
    }, (a) => toolRun(() => acted(tabItem(pid, a.tabId, { op: 'set', itemId: a.itemId, done: a.done }, ctx))))

    server.registerTool('files', {
      description: "List a folder in the project's folder on thor. rel is relative to the project folder; empty is the top.",
      inputSchema: { rel: z.string().max(500).optional() },
    }, (a) => toolRun(async () => {
      const p = getProject(pid)
      if (!p) throw new AgentError(404, 'the project is gone')
      return (await thorFile('tree', p.targetKey, a.rel ?? '')).json()
    }))

    server.registerTool('file_read', {
      description: 'Read a text file (markdown, text, code, csv) from the project folder on thor, up to 80 KB.',
      inputSchema: { rel: z.string().min(1).max(500) },
    }, (a) => toolRun(async () => {
      const p = getProject(pid)
      if (!p) throw new AgentError(404, 'the project is gone')
      const r = await thorFile('file', p.targetKey, a.rel)
      const type = r.headers.get('content-type') || ''
      if (!/^text\//.test(type) && !/\.(md|txt|csv|json|ya?ml|ps1|psm1|ts|tsx|js|mjs|py|sql|xml|html?|ini|conf|log)$/i.test(a.rel)) {
        return `${a.rel} is ${type || 'binary'}; only text files can be read here`
      }
      const buf = Buffer.from(await r.arrayBuffer())
      const text = buf.subarray(0, 80_000).toString('utf8')
      return buf.length > 80_000 ? `${text}\n\n[cut at 80 KB of ${Math.round(buf.length / 1024)} KB]` : text
    }))
  }

  // ------------------------------------------------------ groceries ---

  if (agent.kind === 'shopping') {
    server.registerTool('browser_viewer', {
      description: "Opens the browser viewer (tailnet only) so Brendon can sign in or solve a captcha himself, and returns its link. It closes on its own after the minutes given.",
      inputSchema: { minutes: z.number().int().min(5).max(60).optional() },
    }, (a) => toolRun(() => new Promise((resolve, reject) => {
      execFile('/home/brendon/odin-browser/odin-browser', ['view', String(a.minutes ?? 30)], { timeout: 20_000 }, (err, stdout) => {
        if (err) return reject(new AgentError(502, `the viewer did not start: ${err.message.slice(0, 200)}`))
        const url = /https:\/\/\S+/.exec(String(stdout))?.[0]
        resolve(url ? { url, closesInMinutes: a.minutes ?? 30 } : { output: String(stdout).slice(0, 300) })
      })
    })))
  }
}

async function serve(req: Request, res: Response) {
  const loc = res.locals as Loc
  try {
    const server = new McpServer({ name: 'valkyrie', version: '1.0.0' }, {
      instructions: `You are ${loc.agent.name} (${loc.agent.id}). These tools are how you see your work and talk to Brendon. `
        + 'Everything you post shows in Valkyrie Messages on his phone and desktop.',
    })
    register(server, loc)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => { void transport.close(); void server.close() })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  } catch (e) {
    console.error('[agent-mcp]', (e as Error).message)
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null })
  }
}

router.post('/agent-mcp', guard, serve)
const notAllowed = (_req: Request, res: Response) => {
  res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null })
}
router.get('/agent-mcp', notAllowed)
router.delete('/agent-mcp', notAllowed)

export default router
