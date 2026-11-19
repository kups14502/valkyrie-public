import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Ref } from '../agentsStore.js'

// Raven: Brendon's one assistant, a single DM in Valkyrie Messages (channel
// 'raven' in agents.sqlite). Shared types, fixed before the parts were built
// so the run loop (lib/raven/run.ts), the tools (lib/raven/tools/*) and the
// features that add tools (featureTypes.ts `raven`) agree.

export const RAVEN_ID = 'raven'
export const RAVEN_CHANNEL = 'raven'
export const RAVEN_NAME = 'Raven'

/** The tiers Raven's router picks from; the model id for each comes from RAVEN_MODELS (lib/raven/models.ts). */
export type RavenTier = 'haiku' | 'sonnet' | 'opus'
export type RavenEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** A file Brendon attached (stored on odin under the data dir, raven-files/). */
export type RavenFile = { id: string; name: string; mime: string; size: number; createdAt: string }

/** What a message carries beyond its text (messages.meta, JSON). Every field optional. */
export type RavenMeta = {
  /** Raven's reply: the tier, model id and effort the router chose, and its one-line reason */
  tier?: RavenTier
  model?: string
  effort?: RavenEffort
  why?: string
  /** the message Brendon wrote that this answers */
  replyTo?: number
  /** files on a message (Brendon's attachments) */
  files?: RavenFile[]
  /** a relayed line: who it came from, as shown above it */
  relay?: {
    kind: 'agent' | 'session' | 'feature' | 'system'
    /** agent id, tmux pane name, or source key ('backup') */
    from: string
    /** display name ("Work triage", "Personal (main)", "Backup") */
    label: string
    /** the original message id in its own channel, for an agent relay */
    sourceMessageId?: number
    /** a pane's conversation id, for a session relay */
    sessionId?: string
  }
  /** where the message came in from when Brendon did not type it in the app */
  source?: 'app' | 'quick' | 'siri' | 'hotkey' | 'api'
  /** a run that failed or was stopped */
  error?: string
}

/** Everything a Raven tool needs about the run that called it. */
export type RavenToolCtx = {
  runId: string
  /** true when a message Brendon wrote woke this run (not a relay, an agent reply or a schedule) */
  fromBrendon: boolean
  /**
   * How deep this run sits in a chain of hand-offs: 0 for Brendon's message, the event's hop for a relay. A tool that
   * wakes a work agent (agent_ask) gives that event hop + 1, so a Raven and agent exchange ends at the agents' MAX_HOP.
   */
  hop?: number
  /** count one action: a run that acted is never retried under another credential */
  acted: () => void
  /** a progress line in the DM from Raven, while the run continues */
  post: (text: string, opts?: { refs?: Ref[]; meta?: RavenMeta }) => void
  /** queue an event for Raven's next run (a watched session answered and Raven asked to follow up) */
  wakeRaven: (kind: string, payload: Record<string, unknown>) => void
}

/** One group of Raven tools (lib/raven/tools/*.ts, or a feature's `raven.tools`). */
export type RavenToolGroup = (server: McpServer, ctx: RavenToolCtx) => void

/** A line handed to Raven from outside a run (a feature, an odin process, Valkyrie itself): POST /api/raven/notify or notifyRaven(). */
export type RavenNotice = {
  /** short source key: 'backup', a feature id, 'valkyrie' */
  source: string
  level: 'info' | 'warn' | 'alert'
  title: string
  body?: string
  url?: string
  /** folds repeats: a notice with the same source and tag within 30 minutes replaces nothing and posts nothing */
  tag?: string
  /** display name for the source ("Backup"); defaults to the source key, capitalized */
  label?: string
}
