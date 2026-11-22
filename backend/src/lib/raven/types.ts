import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Ref } from '../agentsStore.js'

// Raven: Brendon's one assistant, a single DM in Valkyrie Messages (channel
// 'raven' in agents.sqlite). Shared types, fixed before the parts were built
// so the run loop (lib/raven/run.ts), the tools (lib/raven/tools/*) and the
// features that add tools (featureTypes.ts `raven`) agree.

export const RAVEN_ID = 'raven'
export const RAVEN_CHANNEL = 'raven'
export const RAVEN_NAME = 'Raven'

/** A model's key in Raven's catalog (lib/raven/models.ts: opus, sonnet, haiku, fable-5-2, fable, or one RAVEN_MODELS adds). */
export type RavenTier = string
export type RavenEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
/** The efforts Brendon picks from in the app. */
export type RavenPickEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * Which automatic rule chose a run's model and effort: the router sorted his message as simple or complex, it came
 * by voice (Siri), or he did not write at all (a relay, an agent's answer, a follow-up).
 */
export type RavenRuleKey = 'simple' | 'complex' | 'voice' | 'background'
export type RavenRule = { model: RavenTier; effort: RavenPickEffort }

/** Brendon's pick in the Raven tab (kv `raven:settings`, so every device shares it): a model and an effort, each fixed or automatic. */
export type RavenSettings = {
  model: RavenTier | 'auto'
  effort: RavenPickEffort | 'auto'
  /** what Automatic uses for each kind of run */
  rules: Record<RavenRuleKey, RavenRule>
}

/** A file Brendon attached (stored on odin under the data dir, raven-files/). */
export type RavenFile = { id: string; name: string; mime: string; size: number; createdAt: string }

/** What a message carries beyond its text (messages.meta, JSON). Every field optional. */
export type RavenMeta = {
  /** Raven's reply: the tier, model id and effort the router chose, and its one-line reason */
  tier?: RavenTier
  model?: string
  effort?: RavenEffort
  why?: string
  /** the automatic rule that chose the model or the effort; absent when he fixed both */
  rule?: RavenRuleKey
  /** the model id that was wanted, when another ran in its place (unknown to the CLI, or it needs usage credits) */
  asked?: string
  /** the message Brendon wrote that this answers */
  replyTo?: number
  /** files on a message (Brendon's attachments) */
  files?: RavenFile[]
  /** a relayed line: who it came from, as shown above it */
  relay?: {
    kind: 'agent' | 'session' | 'feature' | 'system'
    /** agent id, tmux pane name, or source key ('backup') */
    from: string
    /** display name ("Work triage", "Personal", "Backup") */
    label: string
    /** the original message id in its own channel, for an agent relay */
    sourceMessageId?: number
    /** more proposals folded into this relay (the same agent, the same ticket, minutes apart), oldest first */
    proposalIds?: number[]
    /** a pane's conversation id, for a session relay */
    sessionId?: string
    /** a session relay's conversation title from thor's board, added when the thread is read (never stored) */
    title?: string
    /** a feed's notice about a state that changes (a count, an open incident): its key, unique within the source (RavenNotice.live) */
    live?: string
    /** that state as it stands now, when it moved since the notice ("4 items waiting for your review") */
    now?: string
    /** the state is over (the queue is empty, the incident cleared) or a newer notice took its place: when, and a word on it */
    cleared?: { at: string; note?: string }
  }
  /**
   * What the watched sessions wrote that Raven read in the run this message closes, kept under it for history (the
   * app shows it collapsed). Claude's lines only, newest kept when long; the session itself has all of it.
   */
  sessions?: RavenSessionCopy[]
  /** where the message came in from when Brendon did not type it in the app */
  source?: 'app' | 'quick' | 'siri' | 'hotkey' | 'api'
  /** a run that failed or was stopped */
  error?: string
}

/** One line a watched session wrote, as the watcher hands it to Raven (lib/raven/tools/watch.ts). */
export type RavenSaid = { id: string; at: number; from: 'claude' | 'prompt'; text: string }

/** A watched session's lines under Raven's message: pane name (or conversation id), its labels, and what Claude wrote. */
export type RavenSessionCopy = {
  from: string
  label: string
  title?: string
  sessionId?: string
  lines: { at: string; text: string }[]
  /** lines left out of this copy (older ones, past the size kept here) */
  more?: number
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
  /**
   * The notice reports a state that changes (a count waiting, an open incident): a key for that state, stable within
   * the source ('review'). A newer notice with the same key replaces it, and POST /api/raven/notify/clear (clearNotice)
   * updates or closes it, so the sidebar never shows a count that is no longer true.
   */
  live?: string
}

/** POST /api/raven/notify/clear: the state a live notice reported moved (now) or is over (no now). */
export type RavenNoticeClear = {
  source: string
  live: string
  /** the state as it stands now, one line; absent or empty = the state is over and the notice is cleared */
  now?: string
  /** a word for a cleared notice ("All reviewed") */
  note?: string
  /** a notice from before live keys counts as this one when its first line ends with this text */
  legacy?: string
}
