import path from 'node:path'
import { Router, type NextFunction, type Request, type Response } from 'express'
import { isLoopbackReq, requireStrongAuth, viaCloudflare } from '../middleware/auth.js'
import {
  AgentError, currentSeq, listAgents, listMessages, markChannelRead, pendingProposals, proposalsFor, unreadCounts, type Message,
} from '../lib/agentsStore.js'
import { hiddenAreas, isPaused } from '../lib/agents.js'
import { getRavenFile, MAX_FILE_BYTES, RavenFileError, saveRavenFile } from '../lib/raven/files.js'
import { brendonToRaven, ensureRavenChannel, postNotice, ravenStarted, ravenState, stopRaven, waitForReply, withTimeout } from '../lib/raven/run.js'
import { ravenSessionsState } from '../lib/raven/tools/index.js'
import { RAVEN_CHANNEL, type RavenNotice } from '../lib/raven/types.js'

// Raven's thread (lib/raven/run.ts) for the app: the one conversation in the
// Messages tab, its live state, Brendon's attachments, Stop, and the doors in
// from outside the app: /raven/say for the Siri Shortcut and the office
// hotkey, /raven/notify for processes on this host. All of it is
// tailnet only: through Cloudflare every route here answers like it does not
// exist, the same rule as the agents' team channel (Raven relays every area).

const router = Router()

/** POST here carries the raw file, so index.ts keeps the JSON body parser off it. */
export const RAVEN_UPLOAD_PATH = '/api/raven/files'
const SAY_WAIT_MS = Number(process.env.RAVEN_SAY_WAIT_MS || 55_000)

function h(fn: (req: Request, res: Response) => unknown) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res)
    } catch (e) {
      const known = e instanceof AgentError || e instanceof RavenFileError
      if (!known) console.error('[raven]', (e as Error).message)
      if (res.headersSent) return
      res.status(known ? (e as AgentError).status : 500).json({ error: known ? (e as Error).message : 'internal error' })
    }
  }
}

router.use('/raven', (req: Request, res: Response, next: NextFunction) => {
  if (viaCloudflare(req)) return res.status(404).json({ error: 'not found' })
  next()
})

// ------------------------------------------------------------- views ----

export type RavenMsgView = {
  id: number; author: string; text: string; createdAt: string; refs: Message['refs']; meta: Message['meta']
  proposal: { id: number; kind: string; title: string; payload: unknown; status: string; result: string | null; decidedAt: string | null } | null
  /** every proposal when a relay folded in more than one (proposal is the first) */
  proposals?: NonNullable<RavenMsgView['proposal']>[]
}

type ProposalView = NonNullable<RavenMsgView['proposal']>
const proposalIdsOf = (m: Message): number[] => [...(m.proposalId ? [m.proposalId] : []), ...(m.meta.relay?.proposalIds ?? [])]

function messagesView(msgs: Message[]): RavenMsgView[] {
  const props = proposalsFor(msgs.flatMap(proposalIdsOf))
  return msgs.map((m) => {
    const list: ProposalView[] = proposalIdsOf(m).flatMap((id) => {
      const p = props.get(id)
      return p ? [{ id: p.id, kind: p.kind, title: p.title, payload: p.payload, status: p.status, result: p.result || null, decidedAt: p.decidedAt }] : []
    })
    return {
      id: m.id, author: m.author, text: m.text, createdAt: m.createdAt, refs: m.refs, meta: m.meta,
      proposal: list[0] ?? null,
      ...(list.length > 1 ? { proposals: list } : {}),
    }
  })
}

async function stateView(req: Request) {
  // first, so a change made while this answer is put together still refetches
  const seq = currentSeq()
  const st = ravenState()
  const on = ravenStarted()
  const sessions = await withTimeout(ravenSessionsState(), 4_000, { mains: [], watching: [] })
  const pending = pendingProposals()
  const hidden = viaCloudflare(req) ? hiddenAreas() : new Set<string>()
  return {
    seq,
    status: on ? st.status : 'error' as const,
    statusNote: on ? st.statusNote : 'Raven is off on this server',
    tier: st.tier, model: st.model, effort: st.effort,
    unread: unreadCounts().get(RAVEN_CHANNEL)?.unread ?? 0,
    mains: sessions.mains,
    watching: sessions.watching,
    agents: listAgents().filter((a) => a.enabled && !hidden.has(a.area))
      .map((a) => ({ id: a.id, name: a.name, area: a.area, status: a.status, pending: pending.filter((p) => p.agentId === a.id).length })),
    paused: isPaused(),
  }
}

// ---------------------------------------------------------------- UI ----

router.get('/raven', h(async (req, res) => {
  ensureRavenChannel()
  res.json({ ...(await stateView(req)), messages: messagesView(listMessages(RAVEN_CHANNEL, { limit: 60 })) })
}))

router.get('/raven/messages', h((req, res) => {
  const before = Number(req.query.before) || undefined
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 60))
  res.json({ messages: messagesView(listMessages(RAVEN_CHANNEL, { before, limit })) })
}))

router.post('/raven/messages', h((req, res) => {
  const b = req.body ?? {}
  res.json({ message: messagesView([brendonToRaven({ text: b.text, files: b.files, source: b.source })])[0] })
}))

router.post('/raven/read', h((req, res) => {
  const upTo = Number(req.body?.upTo)
  markChannelRead(RAVEN_CHANNEL, Number.isFinite(upTo) && upTo > 0 ? upTo : undefined)
  res.json({ ok: true })
}))

router.post('/raven/stop', h((_req, res) => {
  res.json({ ok: true, stopped: stopRaven() })
}))

// -------------------------------------------------------------- files ----

router.post('/raven/files', h(async (req, res) => {
  const len = Number(req.headers['content-length'])
  if (Number.isFinite(len) && len > MAX_FILE_BYTES) throw new RavenFileError(413, `a file can be at most ${MAX_FILE_BYTES / 1024 / 1024} MB`)
  const file = await saveRavenFile(req, { name: req.header('x-file-name'), mime: req.header('content-type') })
  res.json(file)
}))

// Shown inline with its real type only for kinds a browser shows and never
// runs (images, video, audio, PDF). Anything a browser would run as a page or a
// script on this origin (HTML, SVG, any XML, scripts, other text) comes back as
// plain text. Every other kind is a download. Everything but a PDF also gets a
// sandboxing CSP.
const INLINE_AS_IS = /^(?:image\/(?:png|jpeg|gif|webp|heic|heif|avif|bmp|tiff)|video\/[\w.+-]+|audio\/[\w.+-]+|application\/pdf)$/
const AS_TEXT = /^text\/|^application\/(?:json|yaml|x-yaml)$|xml|html|script|svg/

const encodeRfc5987 = (s: string) => encodeURIComponent(s).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

router.get('/raven/files/:id', h((req, res) => {
  const got = getRavenFile(String(req.params.id))
  if (!got) throw new AgentError(404, 'no such file')
  const { file } = got
  const asIs = INLINE_AS_IS.test(file.mime)
  const asText = !asIs && AS_TEXT.test(file.mime)
  res.setHeader('Content-Type', asText ? 'text/plain; charset=utf-8' : file.mime)
  res.setHeader('Content-Disposition', `${asIs || asText ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeRfc5987(file.name)}`)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cache-Control', 'private, max-age=86400')
  if (file.mime !== 'application/pdf') {
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox")
  }
  res.sendFile(path.resolve(got.path), { dotfiles: 'allow' })
}))

// ---------------------------------------------------------- the doors ----

/** Markdown out, so the Shortcut can speak it: no links, no lists, no emphasis. */
export function speakable(md: string): string {
  const lines = md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<?https?:\/\/[^\s>)]+>?/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|\s)\*([^*\s][^*]*)\*/g, '$1$2')
    .replace(/\s*\u2014\s*/g, ', ')
    .split('\n')
    .map((l) => (l.includes('|') ? l.split('|').map((c) => c.trim()).filter((c) => c && !/^[-:\s]+$/.test(c)).join(', ') : l))
    .map((l) => l.replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const text = lines.map((l) => (/[.!?:;,]$/.test(l) ? l : `${l}.`)).join(' ').replace(/\s+([.,!?])/g, '$1').trim()
  return text.length > 700 ? `${text.slice(0, 697).replace(/\s+\S*$/, '')}...` : text
}

// The Siri Shortcut and the office hotkey. Strong auth: his phone is a trusted
// tailnet device; anything else needs the app token.
router.post('/raven/say', requireStrongAuth, h(async (req, res) => {
  const b = req.body ?? {}
  const source = ['siri', 'hotkey', 'api'].includes(b.source) ? b.source : 'api'
  const msg = brendonToRaven({ text: b.text, source })
  if (b.wait !== true) {
    res.json({ ok: true, id: msg.id })
    return
  }
  // RAVEN_OFF: nothing will answer, so say so now instead of after 55 s of silence
  if (!ravenStarted()) {
    res.json({ ok: true, id: msg.id, reply: 'Raven is off on this server.', done: true })
    return
  }
  const r = await waitForReply(msg.id, SAY_WAIT_MS)
  if (!r.done) {
    res.json({ ok: true, id: msg.id, reply: 'Still working on it. I will message you when it is done.', done: false })
    return
  }
  res.json({ ok: true, id: msg.id, reply: speakable(r.reply) || 'Done.', done: true })
}))

// A feature's own process and other odin processes: loopback with no proxy in
// between and no browser Origin, like the agents' MCP endpoint.
function loopbackOnly(req: Request, res: Response, next: NextFunction) {
  if (!isLoopbackReq(req) || req.headers.origin) return res.status(403).json({ error: 'notices come from processes on this host only' })
  next()
}

router.post('/raven/notify', loopbackOnly, h((req, res) => {
  const r = postNotice((req.body ?? {}) as RavenNotice)
  res.json({ ok: true, posted: r.posted })
}))

export default router
