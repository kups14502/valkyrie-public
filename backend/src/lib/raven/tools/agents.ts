import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { addEvent, getAgent, listAgents, listMessages, pendingProposals, type Agent } from '../../agentsStore.js'
import { checkNow, isPaused, setPaused, wake } from '../../agents.js'
import { RAVEN_CHANNEL, RAVEN_ID, type RavenToolCtx } from '../types.js'
import { clip, et, needBrendon, RavenToolError, toolRun } from './util.js'

// The work agents (lib/agents.ts), as Raven sees them: who they are and what
// they are doing, their channels, a question put to one, and their pending
// proposals. Raven never approves or declines a proposal: the card is in the
// DM and the decision is Brendon's.

// One more than the run that asks, so an agent-Raven exchange ends at the agents' MAX_HOP.
// An agent's answer in the DM wakes Raven, and a question back wakes the agent:
// without Brendon in between, one question per agent per 10 minutes.
const ASK_AGAIN_MS = 10 * 60_000
const askedAt = new Map<string, number>()

function findAgent(name: string): Agent {
  const s = name.trim().replace(/^@/, '').toLowerCase()
  const all = listAgents()
  const exact = all.find((a) => a.id === s) ?? all.find((a) => a.name.toLowerCase() === s)
  if (exact) return exact
  const hits = all.filter((a) => a.name.toLowerCase().includes(s) || a.id.includes(s))
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) throw new RavenToolError(`"${name}" matches ${hits.map((a) => `${a.name} (@${a.id})`).join(', ')}`)
  throw new RavenToolError(`no agent "${name}"; agents lists them`)
}

export function registerAgentTools(server: McpServer, ctx: RavenToolCtx): void {
  server.registerTool('agents', {
    description: 'The work agents: id, name, area, role, status (idle/queued/working/resting/error), what they are on, last run, pending proposals. '
      + 'paused is the global pause.',
    inputSchema: {},
  }, () => toolRun(() => {
    const pending = new Map<string, number>()
    for (const p of pendingProposals()) pending.set(p.agentId, (pending.get(p.agentId) ?? 0) + 1)
    return {
      paused: isPaused(),
      agents: listAgents().filter((a) => a.enabled).map((a) => ({
        id: a.id, name: a.name, area: a.area, role: a.role, status: a.status, statusNote: a.statusNote || undefined,
        lastRun: et(a.lastRunAt) || undefined, pendingProposals: pending.get(a.id) || undefined,
      })),
    }
  }))

  server.registerTool('agent_channel', {
    description: "An agent's own channel, oldest first (what it posted, what Brendon told it). agent is its id or name.",
    inputSchema: { agent: z.string().max(80), limit: z.number().int().min(1).max(60).optional() },
  }, (a) => toolRun(() => {
    const agent = findAgent(a.agent)
    return {
      agent: agent.id, name: agent.name,
      messages: listMessages(agent.channelId, { limit: a.limit ?? 20 }).map((m) => ({
        id: m.id, at: et(m.createdAt), from: m.author, text: clip(m.text, 1500), proposal: m.proposalId ?? undefined,
      })),
    }
  }))

  server.registerTool('agent_ask', {
    description: 'Put a question or a task to a work agent. It wakes and answers with a post in this DM, which wakes you again. '
      + 'Name the mail or ticket by number; never carry one work area\'s client details to another area\'s agent.',
    inputSchema: { agent: z.string().max(80), text: z.string().min(1).max(3000) },
  }, (a) => toolRun(() => {
    const agent = findAgent(a.agent)
    if (!agent.enabled) throw new RavenToolError(`${agent.name} is switched off (${agent.statusNote || 'disabled'})`)
    const prev = askedAt.get(agent.id) ?? 0
    if (!ctx.fromBrendon && Date.now() - prev < ASK_AGAIN_MS) {
      throw new RavenToolError(`You asked ${agent.name} at ${et(prev)} and this run was not woken by Brendon. Pass on what it said, or tell Brendon what you would ask next.`)
    }
    askedAt.set(agent.id, Date.now())
    const last = listMessages(RAVEN_CHANNEL, { limit: 1 })[0]
    addEvent(agent.id, 'message', {
      channelId: RAVEN_CHANNEL, messageId: last?.id, from: RAVEN_ID,
      text: `${a.text.trim()}\n(From Raven, Brendon's assistant. Answer with post, channel "${RAVEN_CHANNEL}": Raven passes it on to him.)`,
    }, (ctx.hop ?? 0) + 1)
    wake(agent.id, 3_000, 'a question from Raven')
    ctx.acted()
    return isPaused()
      ? { asked: agent.id, note: 'the agents are paused: it answers once Brendon resumes them' }
      : { asked: agent.id, note: `${agent.name} answers in this DM` }
  }))

  server.registerTool('agents_pause', {
    description: 'Pause or resume every work agent (the global pause). Only when Brendon\'s message asks.',
    inputSchema: { paused: z.boolean() },
  }, (a) => toolRun(() => {
    needBrendon(ctx, 'Pausing or resuming the agents')
    setPaused(a.paused)
    ctx.acted()
    return { paused: a.paused }
  }))

  server.registerTool('agent_check', {
    description: 'Have an agent look over its area now ("check now") and report. Only when Brendon\'s message asks.',
    inputSchema: { agent: z.string().max(80) },
  }, (a) => toolRun(() => {
    needBrendon(ctx, 'A check')
    const agent = findAgent(a.agent)
    checkNow(agent.id)
    ctx.acted()
    return { checking: agent.id, note: `${agent.name} reports in its channel${isPaused() ? ' once the agents are resumed' : ''}` }
  }))

  server.registerTool('proposals', {
    description: "Proposals waiting on Brendon (mail replies, ticket notes and changes). You cannot approve or decline them: point him at the card in this DM.",
    inputSchema: {},
  }, () => toolRun(() => pendingProposals().map((p) => ({
    id: p.id, agent: getAgent(p.agentId)?.name ?? p.agentId, title: p.title, kind: p.kind, at: et(p.createdAt),
  }))))
}
