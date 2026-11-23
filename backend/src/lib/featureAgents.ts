import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Ref } from './agentsStore.js'
import type { RavenNotice } from './raven/types.js'

// Agents a feature adds (featureTypes.ts `agents`): a work agent like the
// others (a row, a home channel, a notebook, runs that wake on events), whose
// brief, tools and approvable actions come from the feature. index.ts hands
// the list over with setFeatureAgents() before the agents start, so no shared
// file names a feature. lib/agents.ts keeps the roster, the runs and the
// notices; routes/agentMcp.ts adds the feature's tools to its agent's runs;
// lib/agentActions.ts runs an approved action.
//
// A feature agent changes nothing on its own: what it wants done is a
// proposal (kind 'feature') that Brendon approves in the app, and only then
// does the action's apply() run, inside the API.

/** What a feature agent's tools get about the run that called them. */
export type FeatureAgentToolCtx = {
  agentId: string
  runId: string
  hop: number
  /** count one action: a run that acted is never retried */
  acted: () => void
  /**
   * Put an action up for Brendon's approval. action names one of the agent's `actions`; args is what its apply()
   * gets. The proposal posts its own message (note, plus Approve and Decline) in the agent's channel and buzzes his
   * phone. Throws (an AgentError) when the action is unknown or its check() refuses the args.
   */
  propose: (p: { action: string; args?: Record<string, unknown>; title: string; note: string; refs?: Ref[] }) => { proposal: number }
}

/** An action a proposal can carry. apply() runs only after Brendon approves, and answers the result in one line. */
export type FeatureAction = {
  /** refuse bad args at proposal time (throw an Error with a plain message) */
  check?: (args: Record<string, unknown>) => void
  apply: (args: Record<string, unknown>) => string | Promise<string>
}

/** An event kind a feature adds to its own agent's queue (addEvent, then wake): how runs name it, and its line in the prompt. */
export type FeatureEvent = {
  /** one, many: the status line and the run log ("a thing to check", "things to check") */
  words: [string, string]
  /** the line under "What woke you"; the raw payload when unset */
  render?: (payload: Record<string, unknown>) => string
}

export type FeatureAgentDef = {
  /** the agent's id (@id), unique across every agent */
  id: string
  name: string
  /** one line: what it does, shown in the roster */
  role: string
  /** its own area key: keeps its channel apart from every other agent's */
  area: string
  /** the home channel's topic */
  topic: string
  /** true: its channel and proposals are tailnet only, never through Cloudflare */
  tailnetOnly?: boolean
  sortOrder?: number
  /** the role part of its system prompt (the shared rules come first, its id and channel after) */
  brief: () => string
  /** a live block for each run's prompt: what its area looks like now */
  status?: () => string | Promise<string>
  /** the MCP tools it acts with, besides the shared ones (post, read_channel, dm, notebook_set) */
  tools?: (server: McpServer, ctx: FeatureAgentToolCtx) => void
  /** what its proposals can do once approved, by action key */
  actions?: Record<string, FeatureAction>
  /**
   * Raven notices this agent takes instead of the thread: each one wakes it with a 'notice' event, and it
   * explains the problem to Brendon itself. When it cannot run (switched off, paused, at its cap) the notice goes
   * to the thread as before, and so does one it did not post about or that its run failed on.
   */
  takesNotice?: (n: RavenNotice) => boolean
  /** the feature's own event kinds, by kind (the feature queues them itself) */
  events?: Record<string, FeatureEvent>
}

/** A feature agent with the feature it came from. */
export type FeatureAgent = FeatureAgentDef & { feature: string }

const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{1,30}$/

let defs: FeatureAgent[] = []

/** The feature agents (index.ts, from features.ts). A bad or repeated id is left out with a warning. */
export function setFeatureAgents(list: FeatureAgent[]): void {
  const seen = new Set<string>()
  defs = list.filter((d) => {
    if (!AGENT_ID_RE.test(d.id) || seen.has(d.id)) {
      console.warn(`[agents] feature ${d.feature}: agent id "${d.id}" refused (bad or repeated)`)
      return false
    }
    seen.add(d.id)
    return true
  })
}

export const featureAgents = (): FeatureAgent[] => defs
export const featureAgent = (id: string): FeatureAgent | null => defs.find((d) => d.id === id) ?? null
/** The feature event of this kind, whichever feature agent declares it. */
export const featureEvent = (kind: string): FeatureEvent | null => defs.map((d) => d.events?.[kind]).find((e) => e !== undefined) ?? null
