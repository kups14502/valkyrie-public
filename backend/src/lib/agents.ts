import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  addEvent, addMessage, agentsWithOpenEvents, archiveChannel, bump, claimEvents, dmChannel, endRun, failStaleRuns, getAgent, getChannel,
  getKv, listAgents, listChannels, listMessages, listRuns, nowIso, openEvents, patchAgent, pruneEvents, pruneMail, pruneMessages,
  pruneTracked, releaseEvents, removedAgentProjects, runsSince, setKv, startRun, trackerCounts, updateMessage, upsertAgent, upsertChannel,
  type Agent, type AgentEvent, type Channel, type Message, type Ref, AgentError,
} from './agentsStore.js'
import { runClaude, nyNowLine } from './claudeCli.js'
import { listProjects, getProject } from './projectsStore.js'
import { listTasks, nyToday } from './tasksStore.js'
import { briefFor } from './agentBriefs.js'
import type { Franchise } from './psa.js'
import { franchiseConf, workConf } from './workConfig.js'
import { AREAS } from './projectAreas.js'
import { MIXABLE_AREAS } from './projectTypes.js'
import { RAVEN_CHANNEL, type RavenNotice } from './raven/types.js'
import { notifyRaven, wakeRavenWith } from './raven/hooks.js'
import { featureAgent, featureAgents } from './featureAgents.js'
import { ravenPush } from './raven/push.js'
import { ensureRavenChannel } from './raven/channel.js'

// Valkyrie's work agents: AI employees that work on their own and talk to
// Brendon (and each other) in Valkyrie Messages.
//
//   one triage agent per franchise   every open ticket in that franchise's
//                                   Autotask, plus the work mail and Teams
//                                   messages that belong to it
//   one agent per project           keeps its project page moving
//   Groceries                       Whole Foods carts on odin's Chromium
//   a feature's agents              brief, tools and actions from the feature
//                                   (lib/featureAgents.ts)
//
// An agent is not a process. It is a row, a channel and a notebook; when
// something wakes it (new mail, a ticket that moved, a message for it) a
// headless Claude Code run on odin reads what woke it and acts through the
// valkyrie tools in routes/agentMcp.ts. Nothing runs on a timer except the
// weekday reviews: no heartbeat (the old OpenClaw heartbeat burned 97.6% of
// that bot's usage).
//
// Anything outward-facing (client mail, ticket notes and changes, new
// tickets) is a proposal Brendon approves one at a time (lib/agentActions.ts).

const MAX_CONCURRENT = Number(process.env.AGENTS_CONCURRENCY || 2)
const HOURLY_CAP = Number(process.env.AGENTS_HOURLY_CAP || 12)
const DAILY_CAP = Number(process.env.AGENTS_DAILY_CAP || 60)
const RUN_TIMEOUT_MS = Number(process.env.AGENTS_RUN_TIMEOUT_MS || 12 * 60_000)
export const AGENT_MODEL = process.env.AGENTS_MODEL || 'claude-sonnet-5'
/** How deep one agent waking another may go before the chain stops. */
export const MAX_HOP = 3
const MCP_URL = process.env.AGENTS_MCP_URL || `http://127.0.0.1:${process.env.PORT || 3001}/api/agent-mcp`
const BROWSER_MCP = process.env.AGENTS_BROWSER_MCP || '/home/brendon/odin-browser/mcp/node_modules/@playwright/mcp/cli.js'
/** The smoke test shrinks every wake delay; production runs at 1. */
const DELAY_SCALE = Number(process.env.AGENTS_DELAY_SCALE || 1)

/** The areas that are separate client businesses (odin's project-areas.json), never mixed with another. */
export const clientAreas = (): string[] => AREAS.filter((a) => !MIXABLE_AREAS.includes(a))
/** Areas whose channels stay on the tailnet: every client area, plus team, two-area DMs, Raven's thread (it relays every area) and tailnet-only feature agents. */
export const hiddenAreas = (): Set<string> => new Set([
  ...clientAreas(), 'team', 'raven', ...featureAgents().filter((d) => d.tailnetOnly).map((d) => d.area),
])

// ------------------------------------------------------------- roster ----

type Fixed = { id: string; name: string; role: string; kind: Agent['kind']; area: string; franchise: Franchise | null; sortOrder: number; topic: string }

/** One triage agent per franchise in work-agents.json, then Groceries. */
function fixedAgents(): Fixed[] {
  const triage = workConf().franchises.map((f, i): Fixed => ({
    id: f.agent.id, name: f.agent.name, role: f.agent.role, kind: 'triage', area: f.key, franchise: f.key,
    sortOrder: 10 + i, topic: f.agent.topic,
  }))
  return [...triage, {
    id: 'groceries', name: 'Groceries', role: 'Whole Foods orders through Amazon', kind: 'shopping',
    area: 'personal', franchise: null, sortOrder: 30, topic: 'Recipes in, a filled Whole Foods cart out; you place the order',
  }]
}

/** Project agents are named for the project and answer to its folder key (@<folder-key>). */
function projectAgentId(targetKey: string, projectId: string, taken: Set<string>): string {
  const base = /^[a-z0-9][a-z0-9-]{1,30}$/.test(targetKey) ? targetKey : projectId.slice(0, 32)
  return taken.has(base) ? projectId.slice(0, 40) : base
}

/** Makes the roster match the projects: one agent and channel each (none for a project whose agent was removed), the team channel holding all. Idempotent. */
export function syncRoster(): void {
  const have = new Map(listAgents().map((a) => [a.id, a]))
  const fixed = fixedAgents()
  for (const f of fixed) {
    upsertAgent({ id: f.id, name: f.name, role: f.role, kind: f.kind, area: f.area, franchise: f.franchise, projectId: null, channelId: f.id })
    upsertChannel({ id: f.id, name: f.name, kind: 'home', area: f.area, topic: f.topic, agentIds: [f.id], sortOrder: f.sortOrder })
    const was = have.get(f.id)
    if (was && !was.enabled && was.statusNote.startsWith('franchise removed')) patchAgent(f.id, { enabled: true, statusNote: '' })
  }
  const taken = new Set(fixed.map((f) => f.id))
  const features = new Set<string>()
  for (const d of featureAgents()) {
    const was = have.get(d.id)
    if (taken.has(d.id) || (was && was.kind !== 'feature')) {
      console.warn(`[agents] feature ${d.feature}: agent id ${d.id} is taken by another agent; left out`)
      continue
    }
    upsertAgent({ id: d.id, name: d.name, role: d.role, kind: 'feature', area: d.area, franchise: null, projectId: null, channelId: d.id })
    upsertChannel({ id: d.id, name: d.name, kind: 'home', area: d.area, topic: d.topic.slice(0, 200), agentIds: [d.id], sortOrder: d.sortOrder ?? 40 })
    if (was && !was.enabled && was.statusNote.startsWith('feature removed')) patchAgent(d.id, { enabled: true, statusNote: '' })
    taken.add(d.id)
    features.add(d.id)
  }
  const live = new Set<string>()
  const removed = removedAgentProjects()
  for (const p of listProjects({ includeArchived: false })) {
    if (p.id === 'vk-smoke' || removed.has(p.id)) continue
    const existing = [...have.values()].find((a) => a.projectId === p.id)
    const id = existing?.id ?? projectAgentId(p.targetKey, p.id, new Set([...taken, ...have.keys()]))
    taken.add(id)
    live.add(id)
    upsertAgent({
      id, name: p.name, role: `Runs the ${p.name} project`, kind: 'project', area: p.area,
      franchise: franchiseConf(p.area) ? p.area : null, projectId: p.id, channelId: id,
    })
    upsertChannel({ id, name: p.name, kind: 'home', area: p.area, topic: p.summary.slice(0, 200), agentIds: [id], sortOrder: p.status === 'paused' ? 60 : 50 })
    if (existing && !existing.enabled && existing.statusNote === 'project archived') patchAgent(id, { enabled: true, statusNote: '' })
  }
  // a project archived or removed: its agent stops, its history stays
  for (const a of have.values()) {
    if (a.kind === 'triage' && !taken.has(a.id) && a.enabled) patchAgent(a.id, { enabled: false, statusNote: 'franchise removed from work-agents.json' })
    if (a.kind === 'feature' && !features.has(a.id) && a.enabled) patchAgent(a.id, { enabled: false, statusNote: 'feature removed from this build' })
    if (a.kind === 'project' && !live.has(a.id)) {
      if (a.enabled) patchAgent(a.id, { enabled: false, statusNote: 'project archived' })
      if (getChannel(a.channelId) && !getChannel(a.channelId)!.archivedAt) archiveChannel(a.channelId)
    }
  }
  const all = listAgents().filter((a) => a.enabled).map((a) => a.id)
  upsertChannel({ id: 'team', name: 'Team', kind: 'team', area: 'team', topic: 'Everyone. Mention an agent with @ to bring it in.', agentIds: all, sortOrder: 0 })
}

// ------------------------------------------------------------ posting ----

const MENTION_RE = /(^|[^\w@.])@([a-z0-9][a-z0-9-]{1,40})\b/g

export function mentionsIn(text: string): string[] {
  const known = new Set(listAgents().map((a) => a.id))
  const out = new Set<string>()
  for (const m of text.matchAll(MENTION_RE)) {
    const id = m[2]
    if (id === 'brendon' || known.has(id)) out.add(id)
  }
  return [...out]
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** Channels an agent may post in: its own, the team channel, DMs it belongs to, and Raven's thread with Brendon. */
export function canPost(agent: Agent, ch: Channel): boolean {
  if (ch.archivedAt) return false
  if (ch.id === agent.channelId || ch.kind === 'team' || ch.id === RAVEN_CHANNEL) return true
  return ch.kind === 'dm' && ch.agentIds.includes(agent.id)
}

/**
 * Brendon reads everything in Raven's thread now: a post that wants him
 * (notify or @brendon) anywhere else is mirrored there, proposal card and
 * all, and buzzes the phone from there (one push, not two). It does not wake
 * Raven.
 */
function mirrorToRaven(agent: Agent, msg: Message): void {
  ensureRavenChannel()
  if (foldIntoRelay(agent, msg)) return
  addMessage({
    channelId: RAVEN_CHANNEL, author: agent.id, text: msg.text, refs: msg.refs, notify: true, hop: msg.hop, proposalId: msg.proposalId,
    meta: { relay: { kind: 'agent', from: agent.id, label: agent.name, sourceMessageId: msg.id } },
  })
  ravenPush(agent.name, msg.text)
}

const FOLD_MS = 15 * 60_000
// the default line a proposal posts when the agent gave no why: the card under it says it all
const BARE_PROPOSAL_RE = /^(?:An internal note|Draft reply to .{1,120}) for your approval\.?$/i
const ticketKeys = (refs: Ref[]) => refs.flatMap((r) => (r.type === 'ticket' ? [`${r.franchise}:${r.number}`] : []))

/**
 * One relay per ticket: an agent's next post about a ticket it posted about minutes ago
 * (the assignment, then the internal note) joins that relay instead of opening a new one.
 * Only while that relay is still the newest line in the thread, and no second buzz.
 */
function foldIntoRelay(agent: Agent, msg: Message): boolean {
  const keys = ticketKeys(msg.refs)
  if (!keys.length) return false
  const last = listMessages(RAVEN_CHANNEL, { limit: 1 })[0]
  const relay = last?.meta.relay
  if (!last || relay?.kind !== 'agent' || relay.from !== agent.id) return false
  if (Date.now() - Date.parse(last.createdAt) > FOLD_MS) return false
  const had = new Set(ticketKeys(last.refs))
  if (!keys.some((k) => had.has(k))) return false
  const text = BARE_PROPOSAL_RE.test(msg.text.trim()) || last.text.includes(msg.text.trim()) ? last.text : `${last.text}\n\n${msg.text}`
  const seen = new Set(last.refs.map((r) => JSON.stringify(r)))
  const refs = [...last.refs, ...msg.refs.filter((r) => !seen.has(JSON.stringify(r)))]
  let proposalId = last.proposalId
  const more = [...(relay.proposalIds ?? [])]
  if (msg.proposalId) {
    if (proposalId === null) proposalId = msg.proposalId
    else if (proposalId !== msg.proposalId && !more.includes(msg.proposalId)) more.push(msg.proposalId)
  }
  updateMessage(last.id, { text, refs, proposalId, meta: { ...last.meta, relay: { ...relay, ...(more.length ? { proposalIds: more } : {}) } } })
  return true
}

/** A message from an agent. Mentions and DMs wake the agents they name, one hop deeper. */
export function agentPost(agent: Agent, channelId: string, text: string, opts: { refs?: Ref[]; notify?: boolean; hop?: number; proposalId?: number } = {}): Message {
  const ch = getChannel(channelId)
  if (!ch) throw new AgentError(404, `no channel ${channelId}`)
  if (!canPost(agent, ch)) throw new AgentError(403, `you cannot post in #${ch.id}; use your own channel, team, dm, or raven`)
  const body = text.trim()
  if (!body) throw new AgentError(400, 'empty message')
  const mentions = mentionsIn(body).filter((m) => m !== agent.id)
  const notify = Boolean(opts.notify) || mentions.includes('brendon')
  const hop = opts.hop ?? 0
  const inRaven = ch.id === RAVEN_CHANNEL
  const msg = addMessage({
    channelId, author: agent.id, text: body, refs: opts.refs, mentions, notify, hop, proposalId: opts.proposalId ?? null,
    meta: inRaven ? { relay: { kind: 'agent', from: agent.id, label: agent.name } } : undefined,
  })
  const targets = new Set(mentions.filter((m) => m !== 'brendon'))
  if (ch.kind === 'dm') for (const id of ch.agentIds) if (id !== agent.id) targets.add(id)
  if (hop < MAX_HOP) {
    for (const id of targets) {
      const t = getAgent(id)
      if (!t?.enabled) continue
      addEvent(id, 'message', { channelId, messageId: msg.id, from: agent.id, text: clip(body, 2000) }, hop + 1)
      wake(id, 20_000, `message from ${agent.name}`)
    }
  }
  if (inRaven) {
    // Raven passes it on, acts on it, or lets it be: (no reply)
    if (hop < MAX_HOP) wakeRavenWith('agent_reply', { messageId: msg.id, from: agent.id, name: agent.name, text: clip(body, 3000), hop: hop + 1 })
    if (notify) ravenPush(agent.name, body)
  } else if (notify) {
    mirrorToRaven(agent, msg)
  }
  return msg
}

/** A message from Brendon. In an agent's own channel or a DM it wakes them; in Team only the agents he names. */
export function brendonPost(channelId: string, text: string, refs: Ref[] = []): { message: Message; woke: string[] } {
  const ch = getChannel(channelId)
  if (!ch || ch.archivedAt) throw new AgentError(404, `no channel ${channelId}`)
  const body = text.trim()
  if (!body) throw new AgentError(400, 'empty message')
  if (body.length > 8000) throw new AgentError(400, 'keep a message under 8,000 characters')
  const mentions = mentionsIn(body).filter((m) => m !== 'brendon')
  const message = addMessage({ channelId, author: 'brendon', text: body, refs, mentions })
  const targets = new Set(mentions)
  if (ch.kind !== 'team' && !mentions.length) for (const id of ch.agentIds) targets.add(id)
  const woke: string[] = []
  for (const id of targets) {
    const a = getAgent(id)
    if (!a?.enabled) continue
    addEvent(id, 'message', { channelId, messageId: message.id, from: 'brendon', text: clip(body, 4000) }, 0)
    wake(id, 6_000, 'message from Brendon')
    woke.push(id)
  }
  return { message, woke }
}

/** A line from Valkyrie itself (a run failed, a proposal went out). Never wakes anyone. */
export function systemPost(channelId: string, text: string, refs: Ref[] = []): Message | null {
  if (!getChannel(channelId)) return null
  return addMessage({ channelId, author: 'system', text, refs })
}

// ------------------------------------------------------------ waking -----

const timers = new Map<string, { at: number; t: NodeJS.Timeout }>()
const running = new Set<string>()
const queue: string[] = []

export const isPaused = () => getKv('paused') === '1'

export function setPaused(paused: boolean): void {
  setKv('paused', paused ? '1' : '0')
  bump()
  if (!paused) for (const id of agentsWithOpenEvents()) wake(id, 5_000, 'resumed')
}

/** Runs the agent after delayMs, unless it already has an earlier run coming. */
export function wake(agentId: string, delayMs: number, why: string): void {
  const a = getAgent(agentId)
  if (!a?.enabled || isPaused()) return
  delayMs = Math.max(0, delayMs * DELAY_SCALE)
  const at = Date.now() + delayMs
  const cur = timers.get(agentId)
  if (cur && cur.at <= at) return
  if (cur) clearTimeout(cur.t)
  const t = setTimeout(() => { timers.delete(agentId); enqueue(agentId) }, delayMs)
  t.unref?.()
  timers.set(agentId, { at, t })
  if (!running.has(agentId) && a.status !== 'working') patchAgent(agentId, { status: 'queued', statusNote: why })
}

function enqueue(id: string): void {
  if (!queue.includes(id) && !running.has(id)) queue.push(id)
  pump()
}

function pump(): void {
  while (running.size < MAX_CONCURRENT && queue.length) {
    const id = queue.shift()!
    if (running.has(id)) continue
    running.add(id)
    void runAgent(id).finally(() => {
      running.delete(id)
      if (openEvents(id).length && !isPaused()) wake(id, 45_000, 'more to do')
      pump()
    })
  }
}

/** Brendon's "check now": a run even with nothing new, with a note saying why. */
export function checkNow(agentId: string): void {
  const a = getAgent(agentId)
  if (!a) throw new AgentError(404, `no agent ${agentId}`)
  if (!a.enabled) throw new AgentError(409, `${a.name} is paused`)
  addEvent(agentId, 'check', { from: 'brendon' })
  wake(agentId, 1_000, 'Brendon asked for a check')
}

// ------------------------------------------------------------- runs ------
// A run's token is how the MCP endpoint knows which agent is calling.

export type RunCtx = { agentId: string; runId: string; hop: number; acted: number }
const RUN_TOKENS = new Map<string, RunCtx>()

export const runForToken = (token: string): RunCtx | null => RUN_TOKENS.get(token) ?? null

function capWait(agentId: string): { until: number; why: string } | null {
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString()
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString()
  if (runsSince(agentId, dayAgo) >= DAILY_CAP) return { until: Date.now() + 3_600_000, why: `daily cap of ${DAILY_CAP} runs` }
  if (runsSince(agentId, hourAgo) >= HOURLY_CAP) return { until: Date.now() + 15 * 60_000, why: `hourly cap of ${HOURLY_CAP} runs` }
  return null
}

/** What woke a run, in words: the status line on the channel list and the run log. */
const TRIGGER_WORDS: Record<string, [string, string]> = {
  mail: ['new mail', 'new mails'],
  ticket_new: ['new ticket', 'new tickets'],
  ticket_activity: ['ticket update', 'ticket updates'],
  ticket_closed: ['ticket closed', 'tickets closed'],
  ticket_reopened: ['ticket reopened', 'tickets reopened'],
  tracker_seeded: ['first look at the tickets', 'first look at the tickets'],
  teams: ['Teams message', 'Teams messages'],
  message: ['a message', 'messages'],
  proposal: ['a proposal decided', 'proposals decided'],
  daily_review: ['morning review', 'morning review'],
  daily_check: ['morning check', 'morning check'],
  check: ['a check you asked for', 'a check you asked for'],
  notice: ['a problem notice', 'problem notices'],
}

function triggerLine(events: AgentEvent[]): string {
  const counts = new Map<string, number>()
  for (const e of events) counts.set(e.kind.replace(/^retry:/, ''), (counts.get(e.kind.replace(/^retry:/, '')) ?? 0) + 1)
  return [...counts].map(([k, n]) => {
    const [one, many] = TRIGGER_WORDS[k] ?? [k, k]
    return n > 1 && one !== many && !many.startsWith('morning') ? `${n} ${many}` : one
  }).join(', ')
}

async function runAgent(agentId: string): Promise<void> {
  const agent = getAgent(agentId)
  if (!agent?.enabled || isPaused()) return
  const events = openEvents(agentId)
  if (!events.length) {
    if (agent.status === 'queued') patchAgent(agentId, { status: 'idle', statusNote: '' })
    return
  }
  const cap = capWait(agentId)
  if (cap) {
    patchAgent(agentId, { status: 'resting', statusNote: `${cap.why}; ${events.length} waiting` })
    wake(agentId, cap.until - Date.now(), 'after the cap')
    return
  }
  const runId = randomUUID()
  claimEvents(agentId, runId, events.map((e) => e.id))
  const trigger = triggerLine(events)
  startRun(runId, agentId, trigger)
  patchAgent(agentId, { status: 'working', statusNote: trigger })
  const token = randomBytes(24).toString('hex')
  const ctx: RunCtx = { agentId, runId, hop: Math.max(0, ...events.map((e) => e.hop)), acted: 0 }
  RUN_TOKENS.set(token, ctx)
  const dir = await mkdtemp(path.join(tmpdir(), 'valkyrie-agent-'))
  const t0 = Date.now()
  try {
    const work = path.join(dir, 'work')
    await mkdir(work)
    const servers: Record<string, unknown> = {
      valkyrie: { type: 'http', url: MCP_URL, headers: { 'X-Agent-Token': token } },
    }
    if (agent.kind === 'shopping') {
      servers.browser = { type: 'stdio', command: process.execPath, args: [BROWSER_MCP, '--cdp-endpoint', 'http://127.0.0.1:9222'] }
    }
    const mcpFile = path.join(dir, 'mcp.json')
    await writeFile(mcpFile, JSON.stringify({ mcpServers: servers }), { mode: 0o600 })
    const { system, prompt } = await buildPrompt(agent, events)
    const result = await runClaude([
      '-p', prompt,
      '--model', agent.model || AGENT_MODEL,
      '--append-system-prompt', system,
      '--output-format', 'json',
      '--strict-mcp-config', `--mcp-config=${mcpFile}`,
      '--permission-mode', 'bypassPermissions',
      // the valkyrie tools (and the browser for Groceries) are all an agent acts with: no built-in tool at all
      // (the deny list alone leaves Monitor, which runs shell commands, and the tools that message other sessions)
      '--tools', '',
      '--disallowed-tools', 'Bash,Edit,Write,Read,Glob,Grep,NotebookEdit,WebFetch,WebSearch,Task,TodoWrite',
      '--no-session-persistence',
    ], { cwd: work, scratch: dir, timeoutMs: RUN_TIMEOUT_MS, retryable: () => ctx.acted === 0 })
    endRun(runId, { status: 'done', summary: result.text.trim(), cred: result.cred, costUsd: result.costUsd, turns: result.turns, durationMs: Date.now() - t0 })
    patchAgent(agentId, { status: 'idle', statusNote: '', lastRunAt: nowIso() })
    // a problem it took must reach Brendon: when its run said nothing in his thread, the notices go there as they came
    if (events.some(isNotice) && !postedToRavenSince(agentId, t0)) noticesToThread(events)
  } catch (e) {
    const msg = (e as Error).message.slice(0, 400)
    endRun(runId, { status: 'failed', error: msg, durationMs: Date.now() - t0 })
    const back = ctx.acted === 0 ? releaseEvents(runId) : 0
    // the notices that will not come back for a retry go to Brendon's thread now
    noticesToThread(back ? events.filter((e) => e.kind.startsWith('retry:')) : events)
    const prev = listRuns(agentId, 2)[1]
    patchAgent(agentId, { status: 'error', statusNote: clip(msg, 160), lastRunAt: nowIso() })
    // the first failure in a row is worth a line; a streak is not
    if (!prev || prev.status !== 'failed') {
      systemPost(agent.channelId, `Run failed: ${clip(msg, 300)}${back ? ` ${back} item${back === 1 ? '' : 's'} will retry once.` : ''}`)
    }
    console.error(`[agents] ${agentId} run failed:`, msg)
  } finally {
    RUN_TOKENS.delete(token)
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

// ------------------------------------------------------------ prompts ----

const ET_TIME = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
export const etLabel = (iso: string | null | undefined) => (iso ? `${ET_TIME.format(Date.parse(iso))} ET` : '')

function renderEvent(e: AgentEvent): string {
  const p = e.payload as Record<string, unknown>
  const s = (k: string) => String(p[k] ?? '')
  const kind = e.kind.replace(/^retry:/, '')
  const retry = e.kind.startsWith('retry:') ? ' (retry: an earlier run failed on this)' : ''
  switch (kind) {
    case 'mail':
      return `- New mail #${s('n')} from ${s('from')} <${s('fromAddress')}>, "${s('subject')}", ${etLabel(s('receivedAt'))}${p.match ? `. Sender: ${s('match')}` : ''}${p.shared ? `. Arrived in the shared mailbox ${s('address')}, not Brendon's own` : ''}. Read it with mail_get ${s('n')}.${retry}`
    case 'ticket_new':
      return `- New ticket ${s('number')} (id ${s('id')}): "${s('title')}", ${s('company')}, ${s('status')}, ${s('priority')}, assigned ${s('assignee') || 'nobody'}.${retry}`
    case 'ticket_activity':
    case 'ticket_closed':
    case 'ticket_reopened':
      return `- Ticket ${s('number')} (id ${s('id')}) "${s('title')}" ${kind.replace('ticket_', '')}: ${(p.changes as string[] | undefined)?.join('; ') || 'activity'}.${retry}`
    case 'tracker_seeded':
      return `- You now track ${s('open')} open tickets (first look). Read them with tickets, set a summary and next step on each one that matters, and post Brendon one short overview.`
    case 'teams':
      return `- Teams message in "${s('chat')}" from ${s('from')}, ${etLabel(s('createdAt'))}: ${s('text')}${retry}`
    case 'message':
      if (s('channelId') === RAVEN_CHANNEL) {
        const who = s('from') === 'brendon' ? 'Brendon' : s('from') === 'raven' ? "Raven (Brendon's assistant)" : `@${s('from')}`
        return `- In #raven (Raven's thread with Brendon), ${who} wrote to you (message ${s('messageId')}): ${s('text')}. `
          + `Answer there: post with channel "raven". Keep other work areas' client details out of it.${retry}`
      }
      return `- In #${s('channelId')}, ${s('from') === 'brendon' ? 'Brendon' : `@${s('from')}`} wrote (message ${s('messageId')}): ${s('text')}${retry}`
    case 'proposal':
      return `- Your proposal #${s('id')} "${s('title')}" is ${s('status')}${p.result ? `: ${s('result')}` : ''}${p.reason ? `. Brendon's reason: ${s('reason')}` : ''}.`
    case 'proposals_declined': {
      const ids = Array.isArray(p.ids) ? (p.ids as number[]) : []
      const span = ids.length ? ` (#${Math.min(...ids)} to #${Math.max(...ids)})` : ''
      return `- Brendon declined ${s('count')} of your waiting proposals at once with Decline all${span}. Nothing was sent or applied.`
        + `${p.reason ? ` His reason: ${s('reason')}.` : ''} Do not propose them again unless something new happens on that ticket or mail.`
    }
    case 'daily_review':
      return '- Weekday morning review: post one message in your channel with what needs Brendon today.'
    case 'daily_check':
      return `- Morning check. Due or overdue on your project: ${s('tasks')}`
    case 'check':
      return '- Brendon pressed "Check now": look over your area and report anything new, or say all clear in one line.'
    case 'notice':
      return `- Problem notice from ${s('label') || s('source')} (${s('level')}), ${etLabel(s('at'))}: ${s('title')}${p.body ? `. ${s('body')}` : ''}${p.url ? ` Link: ${s('url')}` : ''}. `
        + `Brendon hears about it only through you: find the cause with your tools, then post him one message (your channel, notify true) or a proposal.${retry}`
    default:
      return `- ${kind}: ${clip(JSON.stringify(p), 400)}`
  }
}

function roster(self: Agent): string {
  return [
    ...listAgents().filter((a) => a.enabled && a.id !== self.id).map((a) => `- @${a.id}: ${a.name} (${a.area}). ${a.role}`),
    "- Raven: Brendon's assistant, in #raven. When it asks you something, answer there.",
  ].join('\n')
}

function renderChannel(ch: Channel, limit: number): string {
  const msgs = listMessages(ch.id, { limit })
  if (!msgs.length) return `#${ch.id}: (no messages yet)`
  const who = (m: Message) => (m.author === 'brendon' ? 'Brendon' : m.author === 'system' ? 'Valkyrie' : `@${m.author}`)
  return `#${ch.id} (${ch.name}), oldest first:\n` + msgs.map((m) => `[${m.id} · ${etLabel(m.createdAt)}] ${who(m)}: ${clip(m.text, 700)}${m.proposalId ? ` [proposal #${m.proposalId}]` : ''}`).join('\n')
}

async function featureStatus(agent: Agent): Promise<string> {
  const d = agent.kind === 'feature' ? featureAgent(agent.id) : null
  if (!d?.status) return ''
  try {
    return clip(String(await d.status()).trim(), 4000)
  } catch (e) {
    return `(the status did not load: ${clip((e as Error).message, 160)})`
  }
}

async function buildPrompt(agent: Agent, events: AgentEvent[]): Promise<{ system: string; prompt: string }> {
  const project = agent.projectId ? getProject(agent.projectId) : null
  const system = briefFor(agent, project)
  const status = await featureStatus(agent)
  const channels = new Set<string>([agent.channelId])
  for (const e of events) {
    const c = (e.payload as { channelId?: unknown }).channelId
    // Raven's thread holds every area's relays: never shown to one agent
    if (typeof c === 'string' && c !== RAVEN_CHANNEL) channels.add(c)
  }
  const history = [...channels].map((id) => getChannel(id)).filter((c): c is Channel => Boolean(c))
    .map((c) => renderChannel(c, c.id === agent.channelId ? 20 : 12)).join('\n\n')
  const counts = agent.franchise && agent.kind === 'triage' ? trackerCounts(agent.franchise) : null
  const prompt = [
    `Now: ${nyNowLine()}.`,
    counts ? `Tracker: ${counts.open} open tickets, ${counts.mine} assigned to Brendon, ${counts.needsBrendon} marked as needing him.` : '',
    status ? `## Your area now\n\n${status}` : '',
    '## What woke you',
    events.map(renderEvent).join('\n'),
    '## Your notebook',
    agent.notebook.trim() || '(empty. Start one with notebook_set once you learn something worth keeping.)',
    '## Your teammates',
    roster(agent) || '(none)',
    '## Recent messages',
    history,
    '## Now',
    'Handle what woke you with the valkyrie tools. Post to Brendon only when there is something worth his attention, '
      + 'grouped into one message where you can. Finish with one plain line for your own log: what you did.',
  ].filter(Boolean).join('\n\n')
  return { system, prompt }
}

// ------------------------------------------------------------ notices ----
// A Raven notice that a feature agent takes (featureAgents.ts takesNotice)
// wakes that agent instead of going into the thread (lib/raven/run.ts
// postNotice asks here first). It goes to the thread as it came whenever the
// agent cannot run now, its run failed for good, or its run posted nothing
// in the thread: a problem never gets lost behind an agent.

/** Hands a notice to the feature agent that takes it, and answers its id; null when none takes it now. */
export function takeNotice(n: RavenNotice): string | null {
  if (!started || isPaused()) return null
  for (const d of featureAgents()) {
    let takes = false
    try { takes = Boolean(d.takesNotice?.(n)) } catch (e) { console.error(`[agents] ${d.id} takesNotice:`, (e as Error).message) }
    if (!takes) continue
    const a = getAgent(d.id)
    if (!a?.enabled || a.kind !== 'feature' || capWait(a.id)) return null
    addEvent(a.id, 'notice', {
      source: n.source, label: n.label ?? '', level: n.level, title: n.title, body: n.body ?? '', url: n.url ?? '', tag: n.tag ?? '', live: n.live ?? '', at: nowIso(),
    })
    // the notices of one pass arrive together: one run takes them all
    wake(a.id, 20_000, 'a problem notice')
    return a.id
  }
  return null
}

const isNotice = (e: AgentEvent) => e.kind.replace(/^retry:/, '') === 'notice'

function noticesToThread(events: AgentEvent[]): void {
  for (const e of events) {
    if (!isNotice(e)) continue
    const p = e.payload as Record<string, unknown>
    const s = (k: string) => (typeof p[k] === 'string' && p[k] ? String(p[k]) : undefined)
    notifyRaven({
      source: s('source') ?? 'valkyrie', level: (s('level') as RavenNotice['level']) ?? 'warn', title: s('title') ?? 'A problem notice',
      body: s('body'), url: s('url'), tag: s('tag'), label: s('label'), live: s('live'),
    }, { direct: true })
  }
}

/** True when the agent wrote in Raven's thread (an answer, a mirrored post or proposal) since t0. */
function postedToRavenSince(agentId: string, t0: number): boolean {
  return listMessages(RAVEN_CHANNEL, { limit: 30 }).some((m) => m.author === agentId && Date.parse(m.createdAt) >= t0)
}

// ------------------------------------------------------------ schedule ---

const NY_HM = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' })

function nyClock(): { day: string; hm: string } {
  const parts = Object.fromEntries(NY_HM.formatToParts(Date.now()).map((p) => [p.type, p.value]))
  return { day: parts.weekday, hm: `${parts.hour}:${parts.minute}` }
}

const REVIEW_AT = process.env.AGENTS_REVIEW_AT || '08:30'
const CHECK_AT = process.env.AGENTS_CHECK_AT || '09:00'

function tickSchedule(): void {
  const { day, hm } = nyClock()
  if (day === 'Sat' || day === 'Sun') return
  const today = nyToday()
  if (hm >= REVIEW_AT && getKv('review-day') !== today) {
    setKv('review-day', today)
    for (const a of listAgents()) {
      if (a.enabled && a.kind === 'triage') { addEvent(a.id, 'daily_review', {}); wake(a.id, 5_000, 'morning review') }
    }
  }
  if (hm >= CHECK_AT && getKv('check-day') !== today) {
    setKv('check-day', today)
    const tasks = listTasks({ view: 'open', hideTailnet: false })
    for (const a of listAgents()) {
      if (!a.enabled || a.kind !== 'project' || !a.projectId) continue
      const due = tasks.filter((t) => t.ref.kind === 'project' && t.ref.projectId === a.projectId && t.due && t.due.slice(0, 10) <= today)
      if (!due.length) continue
      addEvent(a.id, 'daily_check', { tasks: due.slice(0, 10).map((t) => `${t.text} (due ${t.due})`).join('; ') })
      wake(a.id, 10_000 + Math.random() * 60_000, 'morning check')
    }
  }
}

let started = false

export function startAgents(): void {
  if (started) return
  started = true
  const stale = failStaleRuns()
  if (stale) console.warn(`[agents] closed ${stale} run(s) cut off by the restart`)
  for (const a of listAgents()) if (a.status === 'working' || a.status === 'queued') patchAgent(a.id, { status: 'idle', statusNote: '' })
  try { syncRoster() } catch (e) { console.error('[agents] roster:', (e as Error).message) }
  const roster = setInterval(() => {
    try { syncRoster() } catch (e) { console.error('[agents] roster:', (e as Error).message) }
  }, 5 * 60_000)
  roster.unref?.()
  const sched = setInterval(() => {
    try { tickSchedule() } catch (e) { console.error('[agents] schedule:', (e as Error).message) }
  }, 60_000)
  sched.unref?.()
  const prune = setInterval(() => {
    try { pruneMessages(); pruneEvents(); pruneMail(); pruneTracked() } catch (e) { console.error('[agents] prune:', (e as Error).message) }
  }, 6 * 3_600_000)
  prune.unref?.()
  // whatever was waiting before the restart
  for (const id of agentsWithOpenEvents()) wake(id, 30_000, 'after restart')
}

export { dmChannel, listChannels }
