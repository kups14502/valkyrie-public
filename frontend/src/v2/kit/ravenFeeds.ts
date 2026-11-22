import type { RavenAgent, RavenFeed, RavenMsg, RavenRelay } from '../../lib/ravenApi'

// The feeds in the Raven tab's Connected list (screens/Messages.tsx). A feed is
// a feature's notices in the thread (backend lib/raven/notices.ts); the list
// shows each feed's newest line. A cleared line (the queue it counted is empty,
// the incident is over) leaves its feed out, and an older line never shows in
// its place. A feed that is an agent's own (a feature agent and the notices
// of that feature) goes under the agent's row, so the name shows once.

const firstLine = (text: string) => text.split('\n')[0].replace(/[*_`#>]/g, '').trim()

/** Each feed's newest line out of the loaded thread, newest first: for a backend that sends no `feeds`. */
export function feedsFromThread(messages: RavenMsg[]): RavenFeed[] {
  const seen = new Set<string>()
  const out: RavenFeed[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    const r = m.meta.relay
    if (r?.kind !== 'feature') continue
    const key = r.from || r.label
    if (seen.has(key)) continue
    seen.add(key)
    if (r.cleared) continue
    out.push({ from: r.from, label: r.label || r.from, text: r.now || firstLine(m.text), at: m.createdAt, id: m.id })
  }
  return out
}

const norm = (s: string) => s.trim().toLowerCase()

/** The agent a feed belongs to: the one whose id is the feed's source, else the one with the feed's name. */
function ownerOf(f: RavenFeed, agents: Pick<RavenAgent, 'id' | 'name'>[]): string | null {
  return agents.find((a) => a.id === f.from)?.id ?? agents.find((a) => norm(a.name) === norm(f.label))?.id ?? null
}

/** The feeds split into the agents' own (by agent id, the newest one each) and the rest, in order. */
export function splitFeeds(feeds: RavenFeed[], agents: Pick<RavenAgent, 'id' | 'name'>[]): { byAgent: Map<string, RavenFeed>; rest: RavenFeed[] } {
  const byAgent = new Map<string, RavenFeed>()
  const rest: RavenFeed[] = []
  for (const f of feeds) {
    const owner = ownerOf(f, agents)
    if (!owner) rest.push(f)
    else if (!byAgent.has(owner) || Date.parse(f.at) > Date.parse(byAgent.get(owner)!.at)) byAgent.set(owner, f)
  }
  return { byAgent, rest }
}

/** What a live notice's line in the thread says under it: "Cleared 2:31 PM · All reviewed", "Now: 4 items waiting", or null. */
export function liveLine(r: RavenRelay | undefined, time: (iso: string) => string): string | null {
  if (r?.cleared) return `Cleared ${time(r.cleared.at)}${r.cleared.note ? ` · ${r.cleared.note}` : ''}`
  if (r?.now) return `Now: ${r.now}`
  return null
}
