import { Router } from 'express'
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { listGigs, createGig, updateGig, deleteGig, addLink } from '../gigs/store.js'

// Gig agent: a small chat endpoint (SSE) that lets the user add, complete,
// and modify gigs in natural language. Tools are in-process wrappers around
// the gig store — the same code paths as the REST routes — so the agent can
// never touch anything but the gig log. Runs on the Claude Code CLI auth of
// the service user (~/.claude), same account as the email classifier.

const router = Router()

const MODEL = process.env.VALKYRIE_GIG_AGENT_MODEL || 'claude-haiku-4-5'

// The ticket sync stamps '[Autotask] <status> · due X · client:Y' as the first
// detail line; surface those as fields so the model doesn't parse them.
function gigBrief(q: ReturnType<typeof listGigs>[number]) {
  const head = (q.detail || '').split('\n')[0]
  const at = head.startsWith('[Autotask]') ? head.slice(10).trim() : null
  return {
    id: q.id,
    title: q.title,
    category: q.category,
    status: q.status,
    tracked: q.tracked,
    autotask: at,
    objectives: q.subgigs.map((s) => ({ id: s.id, title: s.title, done: s.status === 'completed' })),
    links: q.links.map((l) => `${l.kind}:${l.ref}`),
  }
}

const ok = (payload: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(payload) }] })
const fail = (err: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ error: (err as Error).message }) }],
  isError: true,
})

const gigTools = [
  tool('list_gigs', 'List all gigs with ids, status, objectives, and Autotask info. Call this before referencing or modifying existing gigs — never guess ids.', {}, async () => {
    try { return ok(listGigs().map(gigBrief)) } catch (e) { return fail(e) }
  }),
  tool('create_gig', 'Create a new gig, optionally with objectives (checklist steps). Category: main/side/daily for personal, work for job tasks. New gigs start active and tracked.', {
    title: z.string().min(1).max(200),
    category: z.enum(['main', 'side', 'daily', 'work']).optional(),
    detail: z.string().max(4000).optional(),
    objectives: z.array(z.string().min(1).max(200)).max(20).optional(),
  }, async (args) => {
    try {
      const gig = createGig({ title: args.title, category: args.category ?? 'side', detail: args.detail })
      for (const t of args.objectives ?? []) createGig({ title: t, parentId: gig.id })
      return ok({ created: gig.id, title: gig.title })
    } catch (e) { return fail(e) }
  }),
  tool('update_gig', 'Update a gig: rename, change status (active/completed/failed/on_hold), category, detail, or pin/unpin from the dashboard (tracked). Also completes/reopens objectives when given an objective id.', {
    id: z.string().min(1),
    title: z.string().min(1).max(200).optional(),
    detail: z.string().max(4000).optional(),
    category: z.enum(['main', 'side', 'daily', 'work']).optional(),
    status: z.enum(['active', 'completed', 'failed', 'on_hold']).optional(),
    tracked: z.boolean().optional(),
  }, async (args) => {
    try {
      const { id, ...patch } = args
      const gig = updateGig(id, patch)
      return ok({ updated: gig.id, title: gig.title, status: gig.status, tracked: gig.tracked })
    } catch (e) { return fail(e) }
  }),
  tool('add_objectives', 'Add objectives (checklist steps) to an existing gig.', {
    gigId: z.string().min(1),
    titles: z.array(z.string().min(1).max(200)).min(1).max(20),
  }, async (args) => {
    try {
      const made = args.titles.map((t) => createGig({ title: t, parentId: args.gigId }))
      return ok({ added: made.map((m) => ({ id: m.id, title: m.title })) })
    } catch (e) { return fail(e) }
  }),
  tool('delete_gig', 'Permanently delete a gig (or a single objective by its id) and everything attached. Ask the user to confirm before calling this; pass confirm=true only after they agree.', {
    id: z.string().min(1),
    confirm: z.boolean(),
  }, async (args) => {
    try {
      if (!args.confirm) return fail(new Error('not confirmed'))
      deleteGig(args.id)
      return ok({ deleted: args.id })
    } catch (e) { return fail(e) }
  }),
  tool('add_link', 'Attach a ticket number, email ref, or URL to a gig.', {
    gigId: z.string().min(1),
    kind: z.enum(['ticket', 'email', 'url']),
    ref: z.string().min(1).max(500),
    label: z.string().max(300).optional(),
  }, async (args) => {
    try {
      const link = addLink(args.gigId, { kind: args.kind, ref: args.ref, label: args.label })
      return ok({ linked: link.ref })
    } catch (e) { return fail(e) }
  }),
]

// Exported so the general assistant (assistantChat.ts) can mount the same
// gig tools alongside its own — one implementation, two agents.
export const gigServer = createSdkMcpServer({ name: 'gigs', version: '1.0.0', tools: gigTools })
export const GIG_ALLOWED = gigTools.map((t) => `mcp__gigs__${t.name}`)
const ALLOWED = GIG_ALLOWED

const SYSTEM_PROMPT = `You are the Valkyrie gig agent: a terse, game-flavored assistant managing the user's gig log (a KCD2-style task tracker). The user is kups (Brendon), an MSP tech.

Rules:
- Call list_gigs before referencing or changing existing gigs; match by title fuzzily but never guess ids.
- Gigs: category work = mirrors an Autotask ticket; main/side/daily = personal. Status: active, on_hold (waiting on someone/something), completed, failed (abandoned). Tracking auto-follows status (active=tracked); only set tracked to override that.
- WORK gigs sync FROM Autotask every ~10 minutes: the ticket is the source of truth for status/title/notes. Flipping a work gig between active/on_hold here will be reverted by the sync if the ticket disagrees; completing one here does NOT close the real ticket (warn the user, do it only if they insist).
- Deleting is permanent: ask for explicit confirmation first, then call delete_gig with confirm=true.
- Style: answer in 1-3 short lines, terminal flavor, no fluff. After acting, state exactly what changed ("✓ gig accepted: …", "✓ completed: …"). If ambiguous, ask one sharp question.
- A <ui_context> tag may precede the user's message: it is UI state (not user words) naming the gig currently open in their journal pane. When they say "this gig" / "it" or give no gig name, act on that open gig. An explicit gig name in their message always beats the open one.
- Today is {{DATE}}.`

router.post('/gigs/chat', async (req, res) => {
  const { message, sessionId, openGig } = (req.body ?? {}) as {
    message?: string
    sessionId?: string
    openGig?: { id?: string; title?: string } | null
  }
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message required' })
  }
  // The gig open in the UI rides along each turn (it can change mid
  // -conversation), so "mark this done" needs no gig name.
  const ctx = openGig?.id && openGig?.title
    ? `<ui_context>gig open in the journal pane: "${String(openGig.title).slice(0, 200)}" (id: ${String(openGig.id).slice(0, 64)})</ui_context>\n`
    : ''

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()
  const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`)

  const ac = new AbortController()
  // Abort the agent if the CLIENT disconnects. Note: req 'close' fires as
  // soon as the request body is consumed in modern Node, which would abort
  // instantly — the response 'close' is the actual disconnect signal.
  res.on('close', () => { if (!res.writableEnded) ac.abort() })

  try {
    const q = query({
      prompt: ctx + message.slice(0, 4000),
      options: {
        model: MODEL,
        systemPrompt: SYSTEM_PROMPT.replace('{{DATE}}', new Date().toDateString()),
        mcpServers: { gigs: gigServer },
        allowedTools: ALLOWED,
        disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit', 'TodoWrite', 'KillShell', 'BashOutput'],
        maxTurns: 16,
        cwd: '/home/brendon/valkyrie/backend',
        abortController: ac,
        ...(sessionId ? { resume: sessionId } : {}),
      },
    })

    let newSessionId: string | null = null
    for await (const msg of q) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        newSessionId = msg.session_id
      } else if (msg.type === 'assistant') {
        for (const block of msg.message.content ?? []) {
          if (block.type === 'text' && block.text) send({ type: 'text', text: block.text })
          // Only surface gig-tool calls; CLI internals (ToolSearch etc.) are noise.
          else if (block.type === 'tool_use' && String(block.name).startsWith('mcp__gigs__')) {
            send({ type: 'action', name: String(block.name).replace('mcp__gigs__', '') })
          }
        }
      } else if (msg.type === 'result') {
        send({ type: 'done', sessionId: newSessionId ?? sessionId ?? null, isError: msg.subtype !== 'success' })
      }
    }
  } catch (err) {
    if (!ac.signal.aborted) {
      console.error('[gig-chat] failed:', err)
      send({ type: 'error', message: (err as Error).message || 'agent failed' })
    }
  } finally {
    res.end()
  }
})

export default router
