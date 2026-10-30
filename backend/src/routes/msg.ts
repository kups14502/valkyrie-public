import { Router, type Request, type Response } from 'express'
import { requireStrongAuth, viaCloudflare } from '../middleware/auth.js'
import {
  AgentError, claimActions, currentSeq, getAgent, getChannel, getMail, getProposal, listAgents, listChannels, listMessages, listRuns,
  listTracked, markChannelRead, patchAgent, pendingProposals, proposalsFor, trackerCounts, unreadCounts, waitForChange,
  type Agent, type Channel, type Message,
} from '../lib/agentsStore.js'
import { brendonPost, checkNow, hiddenAreas, isPaused, setPaused, AGENT_MODEL } from '../lib/agents.js'
import { actionResult, approveProposal, declineProposal } from '../lib/agentActions.js'
import { feedStatus, ingestMail, ingestTeams } from '../lib/workFeeds.js'
import { PsaError, type Franchise } from '../lib/psa.js'
import { franchiseConf } from '../lib/workConfig.js'

// Valkyrie Messages: Brendon and his agents (lib/agents.ts). The UI reads and
// posts here; thor's Work-Bridge.ps1 feeds mail and Teams in and runs the mail
// actions. Client-area channels, the team channel and DMs are tailnet only:
// through Cloudflare they answer like they do not exist, the same rule as the
// private work mail.

const router = Router()

function h(fn: (req: Request, res: Response) => unknown) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res)
    } catch (e) {
      const known = e instanceof AgentError || e instanceof PsaError
      if (!known) console.error('[msg]', (e as Error).message)
      if (res.headersSent) return
      res.status(known ? (e as AgentError).status : 500).json({ error: known ? (e as Error).message : 'internal error' })
    }
  }
}

const hiddenArea = (req: Request, area: string) => viaCloudflare(req) && hiddenAreas().has(area)

function channelFor(req: Request): Channel {
  const ch = getChannel(String(req.params.id))
  if (!ch || hiddenArea(req, ch.area)) throw new AgentError(404, 'no such channel')
  return ch
}

const agentView = (a: Agent) => ({
  id: a.id, name: a.name, role: a.role, kind: a.kind, area: a.area, franchise: a.franchise, projectId: a.projectId,
  channelId: a.channelId, model: a.model || AGENT_MODEL, enabled: a.enabled, status: a.status, statusNote: a.statusNote, lastRunAt: a.lastRunAt,
})

function messagesView(msgs: Message[]) {
  const props = proposalsFor(msgs.map((m) => m.proposalId).filter((x): x is number => x !== null))
  return msgs.map((m) => {
    const p = m.proposalId ? props.get(m.proposalId) : undefined
    return {
      ...m,
      proposal: p ? { id: p.id, kind: p.kind, title: p.title, payload: p.payload, status: p.status, result: p.result, decidedAt: p.decidedAt } : null,
    }
  })
}

// ------------------------------------------------------------------ UI ---

router.get('/msg/overview', h((req, res) => {
  const unread = unreadCounts()
  const channels = listChannels().filter((c) => !hiddenArea(req, c.area)).map((c) => {
    const last = listMessages(c.id, { limit: 1 })[0]
    return {
      id: c.id, name: c.name, kind: c.kind, area: c.area, topic: c.topic, agentIds: c.agentIds, sortOrder: c.sortOrder,
      lastMessageAt: c.lastMessageAt, last: last ? { author: last.author, text: last.text.slice(0, 140) } : null,
      unread: unread.get(c.id)?.unread ?? 0, notify: unread.get(c.id)?.notify ?? 0,
    }
  })
  const visible = new Set(channels.map((c) => c.id))
  res.json({
    seq: currentSeq(),
    paused: isPaused(),
    channels,
    agents: listAgents().filter((a) => !hiddenArea(req, a.area)).map(agentView),
    pending: pendingProposals().filter((p) => visible.has(p.channelId)).length,
    feeds: viaCloudflare(req) ? null : feedStatus(),
  })
}))

router.get('/msg/count', h((req, res) => {
  const visible = new Set(listChannels().filter((c) => !hiddenArea(req, c.area)).map((c) => c.id))
  let n = 0, k = 0
  for (const [c, v] of unreadCounts()) if (visible.has(c)) { n += v.unread; k += v.notify }
  res.json({ unread: n, notify: k, pending: pendingProposals().filter((p) => visible.has(p.channelId)).length })
}))

router.get('/msg/changes', h(async (req, res) => {
  const since = Number(req.query.since)
  const ac = new AbortController()
  req.on('close', () => ac.abort())
  const seq = await waitForChange(Number.isFinite(since) ? since : -1, 25_000, ac.signal)
  if (!res.headersSent) res.json({ seq })
}))

router.get('/msg/channels/:id', h((req, res) => {
  const ch = channelFor(req)
  const before = Number(req.query.before) || undefined
  const after = req.query.after !== undefined ? Number(req.query.after) : undefined
  const msgs = listMessages(ch.id, { before, after: Number.isFinite(after) ? after : undefined, limit: Number(req.query.limit) || 80 })
  const home = ch.kind === 'home' ? getAgent(ch.agentIds[0] ?? '') : null
  res.json({
    channel: ch,
    messages: messagesView(msgs),
    agent: home ? agentView(home) : null,
    tracker: home?.kind === 'triage' && home.franchise ? trackerCounts(home.franchise) : null,
  })
}))

router.post('/msg/channels/:id/messages', h((req, res) => {
  const ch = channelFor(req)
  const text = typeof req.body?.text === 'string' ? req.body.text : ''
  const r = brendonPost(ch.id, text)
  res.json({ ok: true, message: messagesView([r.message])[0], woke: r.woke })
}))

router.post('/msg/channels/:id/read', h((req, res) => {
  const ch = channelFor(req)
  const upTo = Number(req.body?.upTo)
  markChannelRead(ch.id, Number.isFinite(upTo) && upTo > 0 ? upTo : undefined)
  res.json({ ok: true })
}))

function proposalFor(req: Request) {
  const p = getProposal(Number(req.params.id))
  const ch = p ? getChannel(p.channelId) : null
  if (!p || !ch || hiddenArea(req, ch.area)) throw new AgentError(404, 'no such proposal')
  return p
}

router.post('/msg/proposals/:id/approve', h(async (req, res) => {
  const p = proposalFor(req)
  const b = req.body ?? {}
  const done = await approveProposal(p.id, {
    how: b.how === 'draft' ? 'draft' : 'send',
    body: typeof b.body === 'string' ? b.body : undefined,
    cc: Array.isArray(b.cc) ? b.cc.map(String) : undefined,
  })
  res.json({ ok: true, proposal: done })
}))

router.post('/msg/proposals/:id/decline', h((req, res) => {
  const p = proposalFor(req)
  res.json({ ok: true, proposal: declineProposal(p.id, typeof req.body?.reason === 'string' ? req.body.reason : '') })
}))

function agentFor(req: Request): Agent {
  const a = getAgent(String(req.params.id))
  if (!a || hiddenArea(req, a.area)) throw new AgentError(404, 'no such agent')
  return a
}

router.get('/msg/agents/:id', h((req, res) => {
  const a = agentFor(req)
  res.json({
    agent: { ...agentView(a), notebook: a.notebook },
    runs: listRuns(a.id, 15),
    tracker: a.kind === 'triage' && a.franchise ? trackerCounts(a.franchise) : null,
  })
}))

const MODELS = new Set(['', 'claude-sonnet-5', 'claude-opus-5-5', 'claude-haiku-4-5-20251001', 'claude-fable-5-1'])

router.patch('/msg/agents/:id', h((req, res) => {
  const a = agentFor(req)
  const b = req.body ?? {}
  const patch: Parameters<typeof patchAgent>[1] = {}
  if (typeof b.enabled === 'boolean') {
    patch.enabled = b.enabled
    patch.status = 'idle'
    patch.statusNote = b.enabled ? '' : 'paused by Brendon'
  }
  if (typeof b.model === 'string') {
    if (!MODELS.has(b.model)) throw new AgentError(400, 'unknown model')
    patch.model = b.model
  }
  res.json({ ok: true, agent: agentView(patchAgent(a.id, patch)) })
}))

router.post('/msg/agents/:id/check', h((req, res) => {
  const a = agentFor(req)
  checkNow(a.id)
  res.json({ ok: true })
}))

router.put('/msg/paused', h((req, res) => {
  setPaused(req.body?.paused === true)
  res.json({ ok: true, paused: isPaused() })
}))

router.get('/msg/tickets/:franchise', h((req, res) => {
  const f = String(req.params.franchise) as Franchise
  if (!franchiseConf(f) || viaCloudflare(req)) throw new AgentError(404, 'no such franchise')
  res.json({ tickets: listTracked(f, { open: req.query.closed !== '1', limit: 300 }), counts: trackerCounts(f) })
}))

router.get('/msg/mail/:n', h((req, res) => {
  const m = getMail(Number(req.params.n))
  if (!m || viaCloudflare(req)) throw new AgentError(404, 'no such mail')
  res.json({ mail: m })
}))

// ---------------------------------------------------------------- thor ---
// Strong auth: thor is a trusted tailnet device.

router.post('/msg/feed/mail', requireStrongAuth, h((req, res) => {
  res.json({ ok: true, ...ingestMail(req.body ?? {}) })
}))

router.post('/msg/feed/teams', requireStrongAuth, h((req, res) => {
  res.json({ ok: true, ...ingestTeams(req.body ?? {}) })
}))

router.post('/msg/actions/claim', requireStrongAuth, h((req, res) => {
  const runner = String(req.body?.runner ?? '')
  if (runner !== 'thor') throw new AgentError(400, 'unknown runner')
  res.json({ actions: claimActions(runner) })
}))

router.post('/msg/actions/:id/result', requireStrongAuth, h((req, res) => {
  actionResult(Number(req.params.id), req.body?.ok === true, String(req.body?.result ?? '').slice(0, 2000))
  res.json({ ok: true })
}))

export default router
