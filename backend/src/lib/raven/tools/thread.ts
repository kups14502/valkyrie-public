import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { readThread, searchThread, SEARCH_MAX } from '../history.js'
import type { RavenToolCtx } from '../types.js'
import { toolRun } from './util.js'

// Raven's own thread with Brendon, all of it (lib/raven/history.ts): search
// every message since the thread began and read any of them in full. Read
// only, so they run in any run.

const id = z.number().int().positive()

export function registerThreadTools(server: McpServer, _ctx: RavenToolCtx): void {
  server.registerTool('thread_search', {
    description: 'Search your whole thread with Brendon: every message since it began, not only the last 40 in your prompt. '
      + 'Case-insensitive words; every word must be in a message, and "quoted words" stay one phrase. When no message has them all '
      + '(a typo, a quote he remembers a little wrong), the answer is mode any: messages with some of the words, the most words first. '
      + `Newest first, up to ${SEARCH_MAX} hits, each with its number (#), time, author and a snippet; thread_read reads one in full. `
      + 'from narrows it to his messages (brendon) or yours (raven); sessions also searches the session lines kept under your replies.',
    inputSchema: {
      query: z.string().min(2).max(400),
      from: z.enum(['brendon', 'raven']).optional(),
      before: id.optional().describe('only messages older than this number'),
      limit: z.number().int().min(1).max(SEARCH_MAX).optional(),
      sessions: z.boolean().optional(),
    },
  }, (a) => toolRun(() => {
    const r = searchThread(a.query, { from: a.from, before: a.before, limit: a.limit, sessions: a.sessions })
    if (!r.total) return `No message in the thread has ${r.terms.map((t) => `"${t}"`).join(' or ')}.`
    return r
  }))

  server.registerTool('thread_read', {
    description: 'Read messages of your thread in full, by number (the # in your thread and in thread_search): id for one, '
      + 'around for one with the messages before and after it (context each side, default 3), or from and to for a range, oldest first '
      + '(up to 50 a call, 60 KB). sessions adds the session lines kept under your replies.',
    inputSchema: {
      id: id.optional(),
      around: id.optional(),
      context: z.number().int().min(0).max(20).optional(),
      from: id.optional(),
      to: id.optional(),
      sessions: z.boolean().optional(),
    },
  }, (a) => toolRun(() => readThread(a)))
}
