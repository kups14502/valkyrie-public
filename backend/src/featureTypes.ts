import type { Router } from 'express'
import type { MailFilter } from './lib/mailStore.js'
import type { RavenToolGroup } from './lib/raven/types.js'
import type { FeatureAgentDef } from './lib/featureAgents.js'

// What a feature adds to the API. Features are listed in features.ts and
// mounted by index.ts, the only file that reads that list, so no shared route
// or middleware ever imports a feature.
export type BackendFeature = {
  id: string
  /** mounted on /api ahead of requireAuth: these routes check their own callers */
  openRouter?: Router
  /** mounted on /api behind requireAuth, after every shared route */
  router?: Router
  /** GET routes (path under /api) a media-scoped query token may open, as the Plex poster proxy does */
  mediaTokenPaths?: string[]
  /** routes (full /api path) that take a JSON body up to 12 MB instead of 1 MB */
  largeBodyPaths?: string[]
  /** git repos on this host that Projects and the activity feed read, placed after `after` when it is listed */
  repos?: { path: string; after?: string }[]
  /** true for mail that stays in Mail but never becomes an inbox item (lib/mailStore.ts) */
  mailFilters?: MailFilter[]
  /** runs once the API is listening (timers, pollers) */
  start?: () => void
  /** what the feature adds to Raven, Brendon's assistant (lib/raven): MCP tools, and a plain-words status line for its prompt */
  raven?: {
    tools?: RavenToolGroup
    status?: () => string | Promise<string>
  }
  /** work agents the feature adds (lib/featureAgents.ts): brief, tools and approvable actions; Raven can ask them */
  agents?: FeatureAgentDef[]
}
