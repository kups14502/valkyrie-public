import { Router, type NextFunction, type Request, type Response } from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { isLoopbackReq } from '../middleware/auth.js'
import { AgentError, type Ref } from '../lib/agentsStore.js'
import { etLabel } from '../lib/agents.js'
import { attachmentContent, humanSize, listRavenFiles } from '../lib/raven/files.js'
import { ravenFeatures, ravenLiveSnapshot, ravenMessage, ravenRunForToken, setRavenNotebook } from '../lib/raven/run.js'
import { registerRavenTools } from '../lib/raven/tools/index.js'
import type { RavenToolCtx } from '../lib/raven/types.js'

// Raven's tools (lib/raven/run.ts starts each run with an --mcp-config naming
// this endpoint and the run's token). Loopback only: the runs are claude
// processes on odin itself. The core tools live here; the tool groups under
// lib/raven/tools and each feature's `raven.tools` register on the same
// server, with the run's context (fromBrendon gates the ones that act).

const router = Router()

function guard(req: Request, res: Response, next: NextFunction) {
  // loopback with no proxy in between: `tailscale serve` also reaches us over loopback, with
  // X-Forwarded-For and its own Host, and Cloudflare adds its headers (isLoopbackReq refuses both)
  if (!isLoopbackReq(req) || req.headers.origin) {
    return res.status(403).json({ error: 'raven tools are for raven runs on this host only' })
  }
  const run = ravenRunForToken(String(req.headers['x-raven-token'] ?? ''))
  if (!run) return res.status(401).json({ error: 'no such run' })
  res.locals.ctx = run.ctx
  next()
}

export async function toolRun(fn: () => unknown): Promise<CallToolResult> {
  try {
    const result = await fn()
    return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result ?? { ok: true }) }] }
  } catch (e) {
    if (e instanceof AgentError) return { isError: true, content: [{ type: 'text', text: e.message }] }
    console.error('[raven-mcp]', (e as Error).message)
    return { isError: true, content: [{ type: 'text', text: 'internal error' }] }
  }
}

const refSchema = z.array(z.object({
  type: z.literal('link'),
  url: z.string().max(2000).describe('https:// link, or an app path like /m/tasks'),
  label: z.string().max(80).optional(),
})).max(10).optional()

/** The core tools: post, notebook_set, now, attachment, attachments. */
function registerCore(server: McpServer, ctx: RavenToolCtx): void {
  server.registerTool('post', {
    description: 'Post a progress line in the thread while a long job keeps running. Never the reply itself: your final answer is the reply. '
      + 'refs attach https links or app paths (/m/...).',
    inputSchema: { text: z.string().min(1).max(4000), refs: refSchema },
  }, (a) => toolRun(() => {
    const refs: Ref[] = (a.refs ?? []).filter((r) => /^https:\/\//.test(r.url) || /^\/m\//.test(r.url)).map((r) => ({ type: 'link', url: r.url, label: r.label }))
    ctx.acted()
    const m = ravenMessage(a.text, { refs })
    return { posted: m.id }
  }))

  server.registerTool('notebook_set', {
    description: 'Replace your notebook (your memory between runs) with this text. Keep it under about 2,500 words.',
    inputSchema: { text: z.string().max(20_000) },
  }, (a) => toolRun(() => {
    setRavenNotebook(a.text)
    ctx.acted()
    return { ok: true, chars: a.text.length }
  }))

  server.registerTool('now', {
    description: 'The live snapshot again: main terminals, watched sessions, agents, tasks, inbox, tickets per work area, the status line of each feature.',
    inputSchema: {},
  }, () => toolRun(() => ravenLiveSnapshot()))

  server.registerTool('attachment', {
    description: 'One file Brendon sent, by id: an image comes back as an image (large ones downscaled), a PDF or text file as its text '
      + '(first 60 KB), anything else as its name, type and size.',
    inputSchema: { id: z.string().max(40) },
  }, async (a): Promise<CallToolResult> => {
    try {
      const c = await attachmentContent(a.id)
      if (!c) return { isError: true, content: [{ type: 'text', text: `no file ${a.id}` }] }
      if (c.kind === 'image') return { content: [{ type: 'text', text: c.note }, { type: 'image', data: c.data, mimeType: c.mimeType }] }
      return { content: [{ type: 'text', text: c.text }] }
    } catch (e) {
      console.error('[raven-mcp] attachment', (e as Error).message)
      return { isError: true, content: [{ type: 'text', text: 'the file could not be read' }] }
    }
  })

  server.registerTool('attachments', {
    description: 'Files Brendon sent recently, newest first (id, name, type, size, when).',
    inputSchema: { limit: z.number().int().min(1).max(50).optional() },
  }, (a) => toolRun(() => listRavenFiles(a.limit ?? 15).map((f) => ({
    id: f.id, name: f.name, type: f.mime, size: humanSize(f.size), sent: etLabel(f.createdAt),
  }))))
}

async function serve(req: Request, res: Response) {
  const ctx = res.locals.ctx as RavenToolCtx
  try {
    const server = new McpServer({ name: 'raven', version: '1.0.0' }, {
      instructions: "You are Raven, Brendon's assistant. These tools reach his agents, his Claude sessions, his vault, his work and his media. "
        + 'Your final answer is posted in his thread as your reply.',
    })
    registerCore(server, ctx)
    try {
      registerRavenTools(server, ctx)
    } catch (e) {
      console.error('[raven-mcp] tools:', (e as Error).message)
    }
    for (const f of ravenFeatures()) {
      if (!f.tools) continue
      try {
        f.tools(server, ctx)
      } catch (e) {
        console.error(`[raven-mcp] ${f.id} tools:`, (e as Error).message)
      }
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => { void transport.close(); void server.close() })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  } catch (e) {
    console.error('[raven-mcp]', (e as Error).message)
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null })
  }
}

router.post('/raven-mcp', guard, serve)
const notAllowed = (_req: Request, res: Response) => {
  res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null })
}
router.get('/raven-mcp', notAllowed)
router.delete('/raven-mcp', notAllowed)

export default router
