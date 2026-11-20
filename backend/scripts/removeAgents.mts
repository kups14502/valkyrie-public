/**
 * Removes project agents for good (Brendon's call), keeping their projects. Each agent's rows go
 * to data/removed-agents/<date>-<id>.json first, so one can be put back by hand: re-insert the
 * rows and take its project id out of kv `agents:removed-projects`.
 *
 * Runs on odin against the live data dir, after the API carries removedAgentProjects():
 *   node --import tsx scripts/removeAgents.mts <agent-id> [<agent-id> ...]
 */
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../src/lib/db.js'
import { getAgent, removeAgent } from '../src/lib/agentsStore.js'

const ids = process.argv.slice(2)
if (!ids.length) { console.error('removeAgents: name at least one agent id'); process.exit(2) }
const missing = ids.filter((id) => !getAgent(id))
if (missing.length) { console.error(`removeAgents: no agent ${missing.join(', ')}`); process.exit(2) }

const dir = path.join(DATA_DIR, 'removed-agents')
fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
const day = new Date().toISOString().slice(0, 10)
for (const id of ids) {
  const file = path.join(dir, `${day}-${id}.json`)
  const removed = removeAgent(id) as { agent: { name: string }; messages: unknown[]; runs: unknown[]; channels: unknown[] }
  fs.writeFileSync(file, JSON.stringify(removed, null, 2), { mode: 0o600 })
  console.log(`${id}: ${removed.agent.name}, ${removed.channels.length} channels, ${removed.messages.length} messages, ${removed.runs.length} runs -> ${file}`)
}
