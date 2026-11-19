import { getChannel, upsertChannel } from '../agentsStore.js'
import { RAVEN_CHANNEL, RAVEN_ID, RAVEN_NAME } from './types.js'

// Raven's thread as a channel row, apart from the run loop so the agents'
// relays (lib/agents.ts) can make it without importing lib/raven/run.ts.

/** The thread itself, made on first use. Hidden through Cloudflare by its area (agents.ts hiddenAreas). */
export function ensureRavenChannel(): void {
  if (getChannel(RAVEN_CHANNEL)) return
  upsertChannel({ id: RAVEN_CHANNEL, name: RAVEN_NAME, kind: 'home', area: 'raven', topic: "Brendon's assistant", agentIds: [RAVEN_ID], sortOrder: -10 })
}
