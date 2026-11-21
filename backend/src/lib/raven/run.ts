import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  addEvent, addMessage, AgentError, bump, claimEvents, endRun, failStaleRuns, getAgent, getKv, listAgents, listMessages,
  nowIso, openEvents, pendingProposals, runsSince, setKv, startRun, trackerCounts,
  type AgentEvent, type Message, type Ref,
} from '../agentsStore.js'
import { ClaudeCliError, nyNowLine, runClaude, type CliRun } from '../claudeCli.js'
import { etLabel, isPaused, mentionsIn, takeNotice, wake as wakeAgent } from '../agents.js'
import { onBriefWritten } from '../brief.js'
import { listInbox } from '../inboxStore.js'
import { listTasks, nyToday } from '../tasksStore.js'
import { workConf } from '../workConfig.js'
import { setRavenNoticeHandler, setRavenPoster, setRavenWaker, type NoticeOpts } from './hooks.js'
import { ensureRavenChannel } from './channel.js'
import { ravenBrief } from './brief.js'
import { humanSize, pruneRavenFiles, ravenFilesFor } from './files.js'
import {
  effortFor, effortRefused, errorText, fallbackFor, isEffortError, isUnknownModelError, markBadModel, modelFor, modelLabel, wantedModel,
} from './models.js'
import { chooseRoute, needsRouter, ravenSettings, type Route } from './settings.js'
import { ravenPush } from './push.js'
import { ravenSnapshot, startRavenTools } from './tools/index.js'
import {
  RAVEN_CHANNEL, RAVEN_ID, RAVEN_NAME, type RavenEffort, type RavenMeta, type RavenNotice, type RavenSessionCopy, type RavenTier, type RavenToolCtx, type RavenToolGroup,
} from './types.js'

// Raven's run loop: Brendon's one assistant, a single thread (#raven) in
// Valkyrie Messages. Like a work agent (lib/agents.ts) Raven is not a process:
// a message wakes it, one headless Claude Code run on odin reads what woke it
// and acts through the tools on POST /api/raven-mcp (routes/ravenMcp.ts), and
// its final answer is posted as its reply.
//
// Raven has its own queue (never behind the agents): one run at a time, and
// whatever arrives during a run is handled by the next run together. Its
// state lives in agents.sqlite: kv keys (status, notebook), the events table
// (agentId 'raven'), the runs table, and the messages of channel 'raven'.

export type RavenStatus = 'idle' | 'routing' | 'working' | 'error'
export type RavenRunState = {
  status: RavenStatus; statusNote: string; tier: RavenTier | null; model: string | null; effort: RavenEffort | null; lastRunAt: string | null
}
/** What a feature gives Raven (featureTypes.ts `raven`), handed over by index.ts. */
export type RavenFeature = { id: string; tools?: RavenToolGroup; status?: () => string | Promise<string> }

const HOURLY_CAP = Number(process.env.RAVEN_HOURLY_CAP || 60)
const DAILY_CAP = Number(process.env.RAVEN_DAILY_CAP || 400)
// A run Brendon did not start (what a session wrote, an agent's answer) stops short of the caps, so the last runs of
// the hour and the day are always his. What waits meanwhile is read with the next run.
const BG_HOURLY_CAP = Number(process.env.RAVEN_BG_HOURLY_CAP || Math.max(1, HOURLY_CAP - 15))
const BG_DAILY_CAP = Number(process.env.RAVEN_BG_DAILY_CAP || Math.max(1, DAILY_CAP - 60))
const RUN_TIMEOUT_MS = Number(process.env.RAVEN_RUN_TIMEOUT_MS || 10 * 60_000)
const MCP_URL = process.env.RAVEN_MCP_URL || `http://127.0.0.1:${process.env.PORT || 3001}/api/raven-mcp`
/** The smoke test shrinks every wake delay; production runs at 1. */
const DELAY_SCALE = Number(process.env.RAVEN_DELAY_SCALE || 1)
const BRENDON_DELAY = 500
// a session's mid-turn lines wait a little so several sessions' batches make one run
const WAKE_DELAYS: Record<string, number> = { agent_reply: 5_000, session_reply: 2_000, session_progress: 30_000 }
const HISTORY = 40
const STALE_EVENT_MS = 6 * 3_600_000
const DISALLOWED = 'Bash,Edit,Write,Read,Glob,Grep,NotebookEdit,WebFetch,WebSearch,Task,TodoWrite'

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

// -------------------------------------------------------------- state ----

const STATE_KEY = 'raven:state'
const NOTEBOOK_KEY = 'raven:notebook'
const IDLE: RavenRunState = { status: 'idle', statusNote: '', tier: null, model: null, effort: null, lastRunAt: null }

export function ravenState(): RavenRunState {
  try {
    return { ...IDLE, ...(JSON.parse(getKv(STATE_KEY) ?? '{}') as Partial<RavenRunState>) }
  } catch {
    return { ...IDLE }
  }
}

function setState(patch: Partial<RavenRunState>): void {
  setKv(STATE_KEY, JSON.stringify({ ...ravenState(), ...patch }))
  bump()
}

export const ravenNotebook = (): string => getKv(NOTEBOOK_KEY) ?? ''
export function setRavenNotebook(text: string): void {
  setKv(NOTEBOOK_KEY, text.slice(0, 20_000))
  bump()
}

let started = false
let features: RavenFeature[] = []
export const ravenStarted = () => started
export const ravenFeatures = (): RavenFeature[] => features

export { ensureRavenChannel }

// ------------------------------------------------------------ posting ----

/** A message from Raven in the thread. push buzzes the phone (20 s throttle unless force). */
export function ravenMessage(text: string, opts: { refs?: Ref[]; meta?: RavenMeta; push?: boolean; force?: boolean; notify?: boolean; title?: string } = {}): Message {
  const msg = addMessage({ channelId: RAVEN_CHANNEL, author: RAVEN_ID, text, refs: opts.refs, meta: opts.meta, notify: opts.notify })
  if (opts.push) ravenPush(opts.title ?? opts.meta?.relay?.label ?? RAVEN_NAME, text, { force: opts.force })
  return msg
}

const SOURCES = ['app', 'quick', 'siri', 'hotkey', 'api'] as const
type Source = (typeof SOURCES)[number]
export const isSource = (v: unknown): v is Source => SOURCES.includes(v as Source)

/**
 * A message from Brendon in the thread. It wakes Raven (half a second), and
 * any agent he names with @id as well.
 */
export function brendonToRaven(input: { text?: unknown; files?: unknown; source?: unknown }): Message {
  const body = typeof input.text === 'string' ? input.text.trim() : ''
  const ids = Array.isArray(input.files) ? input.files.filter((x): x is string => typeof x === 'string').slice(0, 10) : []
  const files = ravenFilesFor(ids)
  if (files.length !== ids.length) throw new AgentError(400, 'an attached file is missing; attach it again')
  if (!body && !files.length) throw new AgentError(400, 'empty message')
  if (body.length > 8000) throw new AgentError(400, 'keep a message under 8,000 characters')
  const source: Source = isSource(input.source) ? input.source : 'app'
  ensureRavenChannel()
  const mentions = body ? mentionsIn(body).filter((m) => m !== 'brendon') : []
  const meta: RavenMeta = {}
  if (files.length) meta.files = files
  if (source !== 'app') meta.source = source
  const msg = addMessage({ channelId: RAVEN_CHANNEL, author: 'brendon', text: body, mentions, meta })
  addEvent(RAVEN_ID, 'message', {
    messageId: msg.id, from: 'brendon', text: clip(body, 4000), source,
    files: files.map((f) => ({ id: f.id, name: f.name, mime: f.mime, size: f.size })),
  }, 0)
  wake(BRENDON_DELAY)
  for (const id of mentions) {
    const a = getAgent(id)
    if (!a?.enabled) continue
    addEvent(id, 'message', { channelId: RAVEN_CHANNEL, messageId: msg.id, from: 'brendon', text: clip(body, 4000) }, 0)
    wakeAgent(id, 6_000, 'message from Brendon')
  }
  return msg
}

// ------------------------------------------------------------ notices ----
// A line from outside a run: an odin process over POST /api/raven/notify,
// a feature through notifyRaven(). A repeat (same source and tag) within 30
// minutes of the last one posted is dropped. warn and alert push. A notice a
// feature agent takes (lib/agents.ts takeNotice) wakes that agent instead,
// and the agent tells Brendon itself; direct (that agent's own fallback)
// skips both steps.

const NOTICE_FOLD_MS = 30 * 60_000
const noticeSeen = new Map<string, number>()
const SOURCE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

export function postNotice(n: RavenNotice, opts: NoticeOpts = {}): { posted: boolean; message: Message | null; handedTo?: string } {
  const source = String(n?.source ?? '').trim().toLowerCase()
  if (!SOURCE_RE.test(source)) throw new AgentError(400, 'source must be a short key like backup')
  const level = n.level ?? 'info'
  if (!['info', 'warn', 'alert'].includes(level)) throw new AgentError(400, 'level must be info, warn or alert')
  const title = String(n.title ?? '').trim()
  if (!title) throw new AgentError(400, 'a notice needs a title')
  const body = typeof n.body === 'string' ? n.body.trim() : ''
  const url = typeof n.url === 'string' && (/^https:\/\//.test(n.url) || /^\/m\//.test(n.url)) ? n.url.slice(0, 2000) : null
  const tag = typeof n.tag === 'string' ? n.tag.trim().slice(0, 120) : ''
  if (tag && !opts.direct) {
    const key = `${source}\n${tag}`
    const at = noticeSeen.get(key)
    if (at !== undefined && Date.now() - at < NOTICE_FOLD_MS) return { posted: false, message: null }
    noticeSeen.set(key, Date.now())
    if (noticeSeen.size > 500) for (const [k, v] of noticeSeen) if (Date.now() - v > NOTICE_FOLD_MS) noticeSeen.delete(k)
  }
  const label = (typeof n.label === 'string' && n.label.trim()) ? n.label.trim().slice(0, 40) : source.charAt(0).toUpperCase() + source.slice(1)
  if (!opts.direct) {
    const agent = takeNotice({ source, level, title: title.slice(0, 300), body: body ? clip(body, 3000) : undefined, url: url ?? undefined, tag: tag || undefined, label })
    if (agent) return { posted: false, message: null, handedTo: agent }
  }
  const kind = source === 'valkyrie' || source === 'system' ? 'system' : 'feature'
  ensureRavenChannel()
  const loud = level !== 'info'
  const message = ravenMessage(clip(body ? `${title.slice(0, 300)}\n\n${body}` : title.slice(0, 300), 6000), {
    refs: url ? [{ type: 'link', url, label: 'Open' }] : [],
    meta: { relay: { kind, from: source, label } },
    notify: loud, push: loud, title: label,
  })
  return { posted: true, message }
}

// ------------------------------------------------- waiting on a reply ----
// POST /api/raven/say waits for the run that answers its message.

export type SayResult = { reply: string; done: boolean; error?: boolean }
const waiters = new Map<number, ((r: SayResult) => void)[]>()

export function waitForReply(messageId: number, ms: number): Promise<SayResult> {
  return new Promise((resolve) => {
    const done = (r: SayResult) => { clearTimeout(timer); resolve(r) }
    const timer = setTimeout(() => {
      const list = waiters.get(messageId)?.filter((f) => f !== done) ?? []
      if (list.length) waiters.set(messageId, list)
      else waiters.delete(messageId)
      resolve({ reply: '', done: false })
    }, ms)
    waiters.set(messageId, [...(waiters.get(messageId) ?? []), done])
  })
}

function settle(ids: number[], r: SayResult): void {
  for (const id of ids) {
    const list = waiters.get(id)
    waiters.delete(id)
    for (const f of list ?? []) f(r)
  }
}

// ------------------------------------------------------------- waking ----

type RavenRun = {
  runId: string; fromBrendon: boolean; acted: number; ctx: RavenToolCtx; ac: AbortController; stopped: boolean; hop: number
  /** the second try after a run Brendon started ended with no reply */
  mustAnswer?: boolean
}
const RUN_TOKENS = new Map<string, RavenRun>()
/** The run a raven-mcp request belongs to, by its token. */
export const ravenRunForToken = (token: string): { ctx: RavenToolCtx; fromBrendon: boolean } | null => RUN_TOKENS.get(token) ?? null

let timer: { at: number; t: NodeJS.Timeout } | null = null
let current: RavenRun | null = null
let pumping = false
/** A run is going or due (the smoke test waits on this). */
export const ravenBusy = (): boolean => pumping || timer !== null

/** Runs Raven after delayMs, unless a run is already due sooner. */
export function wakeRaven(delayMs: number): void {
  if (!started) return
  const ms = Math.max(0, delayMs * DELAY_SCALE)
  const at = Date.now() + ms
  if (timer && timer.at <= at) return
  if (timer) clearTimeout(timer.t)
  const t = setTimeout(() => { timer = null; void pump() }, ms)
  t.unref?.()
  timer = { at, t }
}
const wake = wakeRaven

/**
 * Queue an event for Raven's next run and wake it. Never a 'message': that kind is Brendon's own words
 * (brendonToRaven), the one thing that opens the tools that act (ctx.fromBrendon).
 */
export function queueRavenEvent(kind: string, payload: Record<string, unknown>, hop = 0): void {
  if (baseKind(kind) === 'message') throw new AgentError(400, 'a message event comes from Brendon only')
  addEvent(RAVEN_ID, kind, payload, hop)
  wake(WAKE_DELAYS[kind] ?? 2_000)
}

async function pump(): Promise<void> {
  // a run is going; it looks for more when it ends
  if (pumping) return
  pumping = true
  let again = false
  try {
    again = await runOnce()
  } catch (e) {
    console.error('[raven] run loop:', (e as Error).message)
  } finally {
    pumping = false
    if (again) wake(1_000)
  }
}

/** Brendon's Stop: kills the run going now, or drops what waits for one. */
export function stopRaven(): boolean {
  if (current) {
    current.stopped = true
    current.ac.abort()
    return true
  }
  const waiting = openEvents(RAVEN_ID)
  if (!waiting.length) return false
  if (timer) { clearTimeout(timer.t); timer = null }
  claimEvents(RAVEN_ID, `stopped-${randomUUID()}`, waiting.map((e) => e.id))
  const ids = brendonIds(waiting)
  ravenMessage('Stopped.', { meta: { error: 'stopped', ...(ids.length ? { replyTo: Math.max(...ids) } : {}) } })
  settle(ids, { reply: 'Stopped.', done: true })
  setState({ status: 'idle', statusNote: '', tier: null, model: null, effort: null })
  return true
}

// --------------------------------------------------------------- runs ----

const baseKind = (k: string) => k.replace(/^retry:/, '')
const isBrendonEvent = (e: AgentEvent) => baseKind(e.kind) === 'message' && e.payload.from === 'brendon'
/** What a watched session wrote (lib/raven/tools/watch.ts): Brendon has not seen it, only Raven reads it. */
const isSessionEvent = (e: AgentEvent) => baseKind(e.kind) === 'session_reply' || baseKind(e.kind) === 'session_progress'
const brendonIds = (events: AgentEvent[]) => events.filter(isBrendonEvent).map((e) => Number(e.payload.messageId)).filter((n) => Number.isFinite(n) && n > 0)

const capNoteKey = 'raven:cap-note'

/** quiet: a background run held for his share of the cap; it says nothing in the thread. */
function capWait(background: boolean): { until: number; why: string; quiet?: boolean } | null {
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString()
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString()
  const day = runsSince(RAVEN_ID, dayAgo)
  const hour = runsSince(RAVEN_ID, hourAgo)
  if (day >= DAILY_CAP) return { until: Date.now() + 3_600_000, why: `the daily cap of ${DAILY_CAP} runs` }
  if (hour >= HOURLY_CAP) return { until: Date.now() + 15 * 60_000, why: `the hourly cap of ${HOURLY_CAP} runs` }
  if (background && day >= BG_DAILY_CAP) return { until: Date.now() + 3_600_000, why: 'the runs kept for his messages today', quiet: true }
  if (background && hour >= BG_HOURLY_CAP) return { until: Date.now() + 10 * 60_000, why: 'the runs kept for his messages this hour', quiet: true }
  return null
}

function triggerLine(events: AgentEvent[]): string {
  const counts = new Map<string, number>()
  for (const e of events) {
    const k = isBrendonEvent(e) ? 'your message' : baseKind(e.kind).replace(/_/g, ' ')
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return [...counts].map(([k, n]) => (n > 1 ? `${k} x${n}` : k)).join(', ')
}

/** "it timed out", "every Claude account is out of usage", or the CLI's own short line. */
export function errorLine(e: unknown): string {
  const message = (e as Error)?.message ?? String(e)
  const detail = (e as { detail?: string })?.detail ?? ''
  const all = `${message}\n${detail}`
  if (/timed out/i.test(message)) return `it timed out after ${Math.round(RUN_TIMEOUT_MS / 60_000)} minutes`
  if (/usage limit|rate.?limit|out of (?:extra )?usage|limit reached/i.test(all)) return 'every Claude account is out of usage right now'
  if (/not installed/i.test(message)) return 'the claude CLI is not installed on this host'
  const src = detail || message
  const result = /"result"\s*:\s*"((?:[^"\\]|\\.){1,240})/.exec(src)?.[1]
  const first = src.split('\n').map((l) => l.trim()).find((l) => l && !/^Command failed:/.test(l)) ?? ''
  const line = (result ? result.replace(/\\n/g, ' ').replace(/\\"/g, '"') : first.replace(/^[^:]{1,60}:\s*(?=\S)/, '')).replace(/\s+/g, ' ').trim()
  return clip(line || 'the run failed', 240)
}

// exactly "(no reply)", maybe in backticks or bold; a bare "No reply." is an answer ("did she write back?")
const NO_REPLY_RE = /^[`*_]*\(\s*no reply\s*\)[`*_]*\.?$/i
const isSilent = (text: string) => !text.trim() || NO_REPLY_RE.test(text.trim())

/** One run over every open event. Returns true when more arrived meanwhile. */
async function runOnce(): Promise<boolean> {
  const events = openEvents(RAVEN_ID)
  if (!events.length) return false
  const cap = capWait(!events.some(isBrendonEvent))
  if (cap?.quiet) {
    setState({ status: 'idle', statusNote: `Holding updates until ${etLabel(new Date(cap.until).toISOString())}: ${cap.why}` })
    wake(cap.until - Date.now())
    return false
  }
  if (cap) {
    const last = Number(getKv(capNoteKey) ?? 0)
    if (Date.now() - last > 60 * 60_000) {
      setKv(capNoteKey, String(Date.now()))
      ravenMessage(`Resting: I hit ${cap.why}. I pick this up at ${etLabel(new Date(cap.until).toISOString())}.`, { meta: { error: 'cap' } })
    }
    setState({ status: 'idle', statusNote: `Resting: ${cap.why}` })
    wake(cap.until - Date.now())
    return false
  }

  const runId = randomUUID()
  claimEvents(RAVEN_ID, runId, events.map((e) => e.id))
  const fromBrendon = events.some(isBrendonEvent)
  const ids = brendonIds(events)
  const replyTo = ids.length ? Math.max(...ids) : undefined
  startRun(runId, RAVEN_ID, triggerLine(events))
  const run: RavenRun = {
    runId, fromBrendon, acted: 0, ac: new AbortController(), stopped: false, hop: Math.max(0, ...events.map((e) => e.hop)),
    ctx: null as unknown as RavenToolCtx,
  }
  run.ctx = {
    runId,
    fromBrendon,
    hop: run.hop,
    acted: () => { run.acted++ },
    post: (text, opts) => {
      run.acted++
      ravenMessage(text, { refs: opts?.refs, meta: opts?.meta })
    },
    wakeRaven: (kind, payload) => queueRavenEvent(kind, payload, run.hop + 1),
  }
  current = run
  const t0 = Date.now()
  // his pick as it stands when the run starts (the Raven tab's model and effort, kv raven:settings)
  const settings = ravenSettings()
  const bg = settings.rules.background
  let route: Route = { tier: bg.model, effort: bg.effort, why: 'relay', routed: false, rule: 'background' }
  let used: { model: string | null; effort: RavenEffort | null } = { model: null, effort: null }
  // what the watched sessions wrote, kept under whatever this run posts (collapsed in the app)
  const copies = sessionCopies(events)
  const withCopies = (meta: RavenMeta): RavenMeta => (copies.length ? { ...meta, sessions: copies } : meta)
  try {
    if (fromBrendon) {
      const asked = events.filter(isBrendonEvent)
      const text = asked.map((e) => String(e.payload.text ?? '')).join('\n\n')
      const nFiles = asked.reduce((n, e) => n + (Array.isArray(e.payload.files) ? e.payload.files.length : 0), 0)
      // Siri waits on the spoken answer: a run with a voice message in it follows the voice rule, with no router call
      const voice = asked.some((e) => e.payload.source === 'siri')
      if (needsRouter(settings, voice)) setState({ status: 'routing', statusNote: 'Choosing a model', tier: null, model: null, effort: null })
      route = await chooseRoute(settings, { fromBrendon, voice, text, files: nFiles, signal: run.ac.signal })
      if (run.ac.signal.aborted) throw new ClaudeCliError('stopped')
    }
    let result = await runModel(run, route, events, (u) => { used = u })
    // he wrote: he always gets an answer. A run that ends with none goes again once, on a stronger model.
    if (fromBrendon && isSilent(result.text) && !run.ac.signal.aborted) {
      console.warn(`[raven] ${modelLabel(used.model ?? '')} gave Brendon no reply; trying again`)
      run.mustAnswer = true
      // what the first try did stays done: the second only looks and answers
      if (run.acted > 0) run.ctx.fromBrendon = false
      if (route.tier === 'haiku') route = { ...route, tier: 'sonnet', effort: 'medium', why: `${route.why} (again: no reply)` }
      result = await runModel(run, route, events, (u) => { used = u })
    }
    endRun(runId, { status: 'done', summary: result.text.trim(), cred: result.cred, costUsd: result.costUsd, turns: result.turns, durationMs: Date.now() - t0 })
    let reply = result.text.trim()
    if (fromBrendon && isSilent(reply)) reply = 'I have no answer for that. Ask me again in other words.'
    if (reply && !NO_REPLY_RE.test(reply)) {
      const meta: RavenMeta = { tier: route.tier, model: used.model ?? undefined, effort: used.effort ?? undefined, why: route.why, ...pickMeta(route, used.model) }
      if (replyTo) meta.replyTo = replyTo
      const msg = ravenMessage(reply, { meta: withCopies(meta), push: true, force: fromBrendon })
      settle(ids, { reply: msg.text, done: true })
    } else {
      settle(ids, { reply: '', done: true })
    }
  } catch (e) {
    const stopped = run.stopped || run.ac.signal.aborted
    const raw = errorText(e).trim()
    endRun(runId, { status: 'failed', error: stopped ? 'stopped' : raw.slice(0, 400), durationMs: Date.now() - t0 })
    if (stopped) {
      ravenMessage('Stopped.', { meta: withCopies({ error: 'stopped', ...(replyTo ? { replyTo } : {}) }) })
      settle(ids, { reply: 'Stopped.', done: true })
    } else {
      const line = `That failed: ${errorLine(e).replace(/[.\s]+$/, '')}.`
      const meta: RavenMeta = { error: clip(raw, 500), tier: route.tier, model: used.model ?? undefined, effort: used.effort ?? undefined, ...pickMeta(route, used.model) }
      if (replyTo) meta.replyTo = replyTo
      // a failed read of what a session wrote leaves it under the line, so nothing it said is lost
      ravenMessage(line, { meta: withCopies(meta), push: fromBrendon, force: true })
      settle(ids, { reply: line, done: true, error: true })
      console.error('[raven] run failed:', raw.slice(0, 400))
    }
  } finally {
    current = null
    setState({ status: 'idle', statusNote: '', tier: null, model: null, effort: null, lastRunAt: nowIso() })
  }
  return openEvents(RAVEN_ID).length > 0
}

/** A reply's rule (what Automatic chose it by) and the model wanted when another ran in its place. */
function pickMeta(route: Route, model: string | null): Pick<RavenMeta, 'rule' | 'asked'> {
  const out: Pick<RavenMeta, 'rule' | 'asked'> = {}
  if (route.rule) out.rule = route.rule
  const wanted = wantedModel(route.tier)
  if (model && model !== wanted) out.asked = wanted
  return out
}

/** The CLI run itself, with one retry on the fallback model and one on a refused effort. */
async function runModel(run: RavenRun, route: Route, events: AgentEvent[], onUse: (u: { model: string; effort: RavenEffort | null }) => void): Promise<CliRun> {
  const dir = await mkdtemp(path.join(tmpdir(), 'valkyrie-raven-'))
  const token = randomBytes(24).toString('hex')
  RUN_TOKENS.set(token, run)
  try {
    const work = path.join(dir, 'work')
    await mkdir(work)
    const mcpFile = path.join(dir, 'mcp.json')
    await writeFile(mcpFile, JSON.stringify({ mcpServers: { raven: { type: 'http', url: MCP_URL, headers: { 'X-Raven-Token': token } } } }), { mode: 0o600 })
    const { system, prompt } = await buildPrompt(events, run.fromBrendon, run.mustAnswer)
    let model = modelFor(route.tier)
    let effort = effortFor(route.effort)
    for (let attempt = 0; ; attempt++) {
      onUse({ model, effort })
      setState({
        status: 'working', tier: route.tier, model, effort,
        statusNote: `${run.fromBrendon ? 'Thinking' : 'Relaying'} · ${modelLabel(model)}${effort ? ` · ${effort}` : ''}`,
      })
      try {
        return await runClaude([
          '-p', prompt,
          '--model', model,
          ...(effort ? ['--effort', effort] : []),
          '--append-system-prompt', system,
          '--output-format', 'json',
          '--strict-mcp-config', `--mcp-config=${mcpFile}`,
          '--permission-mode', 'bypassPermissions',
          // the raven tools are all it acts with: no built-in tool at all (the deny list alone leaves
          // Monitor, which runs shell commands, and the tools that message or schedule other sessions)
          '--tools', '',
          '--disallowed-tools', DISALLOWED,
          '--no-session-persistence',
        ], {
          cwd: work, scratch: dir, timeoutMs: RUN_TIMEOUT_MS, signal: run.ac.signal,
          retryable: (why) => run.acted === 0 && !isUnknownModelError(why) && !isEffortError(why),
        })
      } catch (e) {
        const msg = errorText(e)
        if (run.ac.signal.aborted || run.acted > 0 || attempt >= 2) throw e
        if (isUnknownModelError(msg)) {
          const next = fallbackFor(route.tier, model)
          if (next) {
            markBadModel(model, msg)
            model = next
            continue
          }
        }
        if (effort && isEffortError(msg)) {
          effort = effortRefused(msg, effort)
          continue
        }
        throw e
      }
    }
  } finally {
    RUN_TOKENS.delete(token)
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

// ------------------------------------------------------------ prompts ----

const str = (v: unknown) => (v === undefined || v === null ? '' : String(v))

// ---- what a watched session wrote ----
// Every line Claude wrote reaches the prompt whole. Only when one run holds more than this (Raven held at a cap
// for a long while) are the oldest lines left out, with a note: the prompt goes to the CLI as one argument, and
// Linux refuses one past 128 KB.
const SESSION_TEXT_MAX = 48_000
/** the copy kept under Raven's message, per session: the newest lines, enough to look back at */
const COPY_MAX = 6_000

type SaidLine = { at: number; from: 'claude' | 'prompt'; text: string }

function saidOf(e: AgentEvent): SaidLine[] {
  const said = e.payload.said
  if (!Array.isArray(said)) return []
  return said.filter((s): s is SaidLine => Boolean(s) && typeof s.text === 'string')
    .map((s) => ({ at: Number(s.at) || Date.parse(e.createdAt), from: s.from === 'prompt' ? 'prompt' : 'claude', text: s.text }))
}

/** Per session event, how many of its oldest lines are left out of the prompt (0: none). The newest lines go in first. */
function sessionCuts(events: AgentEvent[]): Map<number, number> {
  const cuts = new Map<number, number>()
  let left = SESSION_TEXT_MAX
  for (let k = events.length - 1; k >= 0; k--) {
    const e = events[k]
    if (!isSessionEvent(e)) continue
    const said = saidOf(e)
    let i = said.length
    while (i > 0 && said[i - 1].text.length <= left) left -= said[--i].text.length
    if (i > 0) left = 0
    cuts.set(e.id, i)
  }
  return cuts
}

const sessionWho = (p: Record<string, unknown>) => [str(p.label), str(p.pane) && `pane ${str(p.pane)}`].filter(Boolean).join(', ') || 'a watched session'
const atLabel = (ms: number) => etLabel(new Date(ms).toISOString())
// a line's own line breaks, indented under it so the next line's time stands out
const indented = (text: string) => text.replace(/\r/g, '').replace(/\n/g, '\n    ')

function renderSession(e: AgentEvent, cut: number, retry: string): string {
  const p = e.payload
  const kind = baseKind(e.kind)
  const follow = str(p.followUp) ? `\n  Your follow-up instruction for this answer: ${str(p.followUp)}` : ''
  // a job Raven started (lib/raven/tools/watch.ts): this run decides whether it is finished
  const job = p.job === true
    ? `\n  You started this session for a job${str(p.title) ? ` ("${clip(str(p.title), 80)}")` : ''}. If this turn reports the job done, or it failed with nothing left to try, `
      + `session_stop ${str(p.pane)} now, in this run: that ends it and marks it done. If it is still on the job and waits on something long `
      + `(a release, a build), session_keep it. Otherwise it is closed and marked done on its own 15 minutes after this turn.`
    : ''
  // queued before every line went to Raven: the answer alone
  if (!Array.isArray(p.said)) return `- The session ${sessionWho(p)} answered: ${clip(str(p.text), 3000)}${follow}${job}${retry}`
  const said = saidOf(e)
  const jobName = str(p.title) ? ` (job: ${str(p.title)})` : ''
  const state = p.ended ? 'Its pane has ended.' : kind === 'session_progress' ? 'It is still working.' : 'Its turn is over.'
  const out = [`- The session ${sessionWho(p)}${jobName} wrote, in full, oldest first. ${state}${retry}`]
  if (cut > 0) out.push(`  (${cut} older line${cut === 1 ? '' : 's'} left out here for length: session_read shows the latest ones)`)
  for (const s of said.slice(cut)) out.push(`  [${atLabel(s.at)}] ${s.from === 'prompt' ? 'Prompt typed into it' : 'Claude'}: ${indented(s.text.trim())}`)
  if (!said.length) out.push('  (nothing new written)')
  if (p.asking) out.push('  Its screen shows no prompt box: a question, a permission prompt or a menu is open there, waiting on Brendon.')
  if (p.background) out.push('  It still waits on background work (a shell, a monitor or an agent), so more can come from it.')
  return out.join('\n') + follow + job
}

/** The copies kept under Raven's message: Claude's lines per session, newest kept up to COPY_MAX each. */
function sessionCopies(events: AgentEvent[]): RavenSessionCopy[] {
  const by = new Map<string, RavenSessionCopy>()
  for (const e of events) {
    if (!isSessionEvent(e)) continue
    const p = e.payload
    const from = str(p.pane) || str(p.sessionId)
    const key = from || str(p.label)
    let c = by.get(key)
    if (!c) {
      c = { from, label: str(p.label) || 'Session', lines: [] }
      if (str(p.title)) c.title = str(p.title)
      if (str(p.sessionId)) c.sessionId = str(p.sessionId)
      by.set(key, c)
    }
    const lines = Array.isArray(p.said)
      ? saidOf(e).filter((x) => x.from === 'claude').map((x) => ({ at: new Date(x.at).toISOString(), text: x.text.trim() }))
      : str(p.text) ? [{ at: e.createdAt, text: str(p.text).trim() }] : []
    c.lines.push(...lines.filter((l) => l.text))
  }
  const out: RavenSessionCopy[] = []
  for (const c of by.values()) {
    if (!c.lines.length) continue
    let left = COPY_MAX
    let i = c.lines.length
    while (i > 0 && c.lines[i - 1].text.length <= left) left -= c.lines[--i].text.length
    if (i === c.lines.length) {
      // the newest line alone is longer than the copy: its head, cut
      const last = c.lines[i - 1]
      if (i > 1) c.more = i - 1
      c.lines = [{ ...last, text: clip(last.text, COPY_MAX) }]
    } else {
      if (i > 0) c.more = i
      c.lines = c.lines.slice(i)
    }
    out.push(c)
  }
  return out
}

function renderEvent(e: AgentEvent, cut = 0): string {
  const p = e.payload
  const kind = baseKind(e.kind)
  const retry = e.kind.startsWith('retry:') ? ' (a retry: Valkyrie restarted during the first try)' : ''
  if (isBrendonEvent(e)) {
    const files = Array.isArray(p.files) ? p.files as { id: string; name: string; mime: string; size: number }[] : []
    const via = str(p.source) && str(p.source) !== 'app' ? `, sent ${p.source === 'siri' ? 'by voice through Siri' : `from ${str(p.source)}`}` : ''
    const lines = [`- Brendon wrote (message ${str(p.messageId)}${via}): ${str(p.text) || '(no text, only files)'}${retry}`]
    for (const f of files) lines.push(`  Attached: ${f.name} (id ${f.id}, ${f.mime}, ${humanSize(Number(f.size) || 0)}). Look at it with attachment.`)
    if (p.source === 'siri') lines.push('  Your reply is spoken aloud to him: one or two plain sentences, no lists, no links.')
    return lines.join('\n')
  }
  switch (kind) {
    case 'agent_reply':
      return `- @${str(p.from)} (${str(p.name) || str(p.from)}) wrote in this thread (message ${str(p.messageId)}): ${str(p.text)}${retry}`
    case 'session_reply':
    case 'session_progress':
      return renderSession(e, cut, retry)
    case 'message':
      return `- A message from ${str(p.from) || 'someone'}: ${str(p.text)}${retry}`
    default:
      return `- ${kind}: ${clip(JSON.stringify(p), 800)}${retry}`
  }
}

function author(m: Message): string {
  if (m.author === 'brendon') return 'Brendon'
  const relay = m.meta.relay
  if (relay) {
    const what = relay.kind === 'agent' ? `@${relay.from}` : relay.kind === 'session' ? 'session' : relay.kind
    return `${relay.label} (${what})`
  }
  if (m.author === RAVEN_ID) return 'Raven'
  if (m.author === 'system') return 'Valkyrie'
  return `@${m.author}`
}

function renderThread(): string {
  const msgs = listMessages(RAVEN_CHANNEL, { limit: HISTORY })
  if (!msgs.length) return '(nothing yet)'
  return msgs.map((m) => {
    const files = m.meta.files?.length ? ` [files: ${m.meta.files.map((f) => `${f.name} (id ${f.id})`).join(', ')}]` : ''
    const prop = m.proposalId ? ` [proposal #${m.proposalId}]` : ''
    const err = m.meta.error ? ' [failed]' : ''
    return `[${m.id} · ${etLabel(m.createdAt)}] ${author(m)}: ${clip(m.text, 700)}${files}${prop}${err}`
  }).join('\n')
}

export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, () => { clearTimeout(t); resolve(fallback) })
  })
}

/** The live snapshot in a run's prompt (and the `now` tool): sessions, agents, tasks, inbox, tickets, features. */
export async function ravenLiveSnapshot(): Promise<string> {
  const out: string[] = []
  const part = (what: string, fn: () => void) => {
    try { fn() } catch (e) { out.push(`${what}: not available (${(e as Error).message.slice(0, 80)})`) }
  }
  const sessions = await withTimeout(ravenSnapshot(), 5_000, '(the session list did not answer)')
  out.push('Main terminals and watched sessions:', sessions.trim() || '(none)')
  part('Agents', () => {
    const pending = pendingProposals()
    const agents = listAgents().filter((a) => a.enabled)
    out.push(`Agents${isPaused() ? ' (all paused by Brendon)' : ''}:`)
    if (!agents.length) out.push('(none)')
    for (const a of agents) {
      const n = pending.filter((p) => p.agentId === a.id).length
      out.push(`- @${a.id} ${a.name} (${a.area}): ${a.status}${a.statusNote ? ` (${clip(a.statusNote, 80)})` : ''}`
        + `${a.lastRunAt ? `, last run ${etLabel(a.lastRunAt)}` : ''}${n ? `, ${n} proposal${n === 1 ? '' : 's'} waiting on Brendon` : ''}`)
    }
  })
  part('Tasks', () => {
    const today = nyToday()
    const open = listTasks({ view: 'open', hideTailnet: false })
    const overdue = open.filter((t) => t.due && t.due.slice(0, 10) < today).length
    const due = open.filter((t) => t.due && t.due.slice(0, 10) === today).length
    out.push(`Tasks: ${open.length} open, ${overdue} overdue, ${due} due today.`)
  })
  part('Inbox', () => {
    const unread = listInbox({ view: 'open', limit: 500 }).filter((i) => !i.readAt && i.level !== 'info')
    const alerts = unread.filter((i) => i.level === 'alert').length
    out.push(`Inbox: ${unread.length} unread item${unread.length === 1 ? '' : 's'} that need him${alerts ? ` (${alerts} alert${alerts === 1 ? '' : 's'})` : ''}.`)
  })
  part('Tickets', () => {
    const fr = workConf().franchises
    if (!fr.length) return
    out.push('Tickets per work area:')
    for (const f of fr) {
      const c = trackerCounts(f.key)
      out.push(`- ${f.label}: ${c.open} open, ${c.needsBrendon} need him, ${c.mine} assigned to him.`)
    }
  })
  for (const f of features) {
    if (!f.status) continue
    const s = await withTimeout(Promise.resolve().then(() => f.status!()), 4_000, '')
    if (String(s).trim()) out.push(`${f.id}: ${String(s).trim().slice(0, 1500)}`)
  }
  return out.join('\n')
}

// What a session wrote reaches him only through Raven: the bar for telling him, and the rest is silence.
const SESSIONS_NOW = 'He has not seen what the watched sessions wrote: only you read it, and what you say is all he gets of it. '
  + 'Read every line. Tell him only what matters, in one to four plain lines in your own words: a job finished or shipped (say the version), '
  + 'failed or blocked, needs him (a question, a permission, an approval, a device update or an app reload), something risky '
  + '(odin\'s CPU or load, data loss, a stuck build) or a real change of plan. Routine progress, narration and steps that went fine get nothing. '
  + 'Never paste what a session wrote. A job you started that reports it is done: session_stop it in this run (that marks it done) and tell him the result in one line.'

async function buildPrompt(events: AgentEvent[], fromBrendon: boolean, mustAnswer = false): Promise<{ system: string; prompt: string }> {
  const system = ravenBrief({ features: features.filter((f) => f.tools).map((f) => f.id) })
  const cuts = sessionCuts(events)
  const sessions = events.some(isSessionEvent)
  const others = events.some((e) => !isBrendonEvent(e) && !isSessionEvent(e))
  const prompt = [
    `Now: ${nyNowLine()}.`,
    '## What woke you',
    events.map((e) => renderEvent(e, cuts.get(e.id) ?? 0)).join('\n'),
    '## Your notebook',
    ravenNotebook().trim() || '(empty. Start one with notebook_set once you learn something worth keeping.)',
    `## The thread, last ${HISTORY} messages, oldest first`,
    renderThread(),
    '## Live snapshot',
    await ravenLiveSnapshot(),
    '## Now',
    fromBrendon
      ? 'Do what he asked with your tools, then give your reply to him as your final answer. He wrote to you: you always answer him, '
        + 'at least one line, never (no reply). A question about a job you handed on (how long, is it done) gets where it stands now: '
        + 'look at the agent or session first (working since when, what it last said, what it waits on).'
        + (mustAnswer ? ' Your first try this run ended with no reply at all, which left him waiting with nothing: answer him now. '
          + 'Whatever that try already did with your tools stays done: never repeat it, look and answer.' : '')
        + (sessions ? ' The watched sessions\' lines above he has not seen: add a line for each thing in them that matters to him '
          + '(finished, failed or blocked, needs him, risky, a change of plan), nothing for the rest.' : '')
      : [
        'Brendon did not write this time.',
        sessions ? SESSIONS_NOW : '',
        // an agent's post and a notice are already in the thread: repeating them is a second row and a second buzz
        others ? 'An agent\'s post or a notice that woke you is already in the thread where he reads it: never repeat it. '
          + 'Answer it only when it needs a decision or a fact from you that the post does not give him, in one or two lines.' : '',
        'Do a follow-up you were given. When nothing here needs him, your whole final answer is exactly (no reply).',
      ].filter(Boolean).join(' '),
  ].join('\n\n')
  return { system, prompt }
}

// -------------------------------------------------------------- start ----

function postBrief(day: string, text: string): void {
  if (getKv('raven:brief-day') === day) return
  setKv('raven:brief-day', day)
  ensureRavenChannel()
  ravenMessage(text, { meta: { relay: { kind: 'system', from: 'brief', label: 'Morning brief' } }, push: true, title: 'Morning brief' })
}

/** Starts Raven: the thread, the hooks other code posts and wakes through, the tools' watcher. Once. */
export function startRaven(feats: RavenFeature[] = []): void {
  if (started) return
  started = true
  features = feats
  ensureRavenChannel()
  const stale = failStaleRuns(RAVEN_ID)
  if (stale) console.warn(`[raven] closed ${stale} run(s) cut off by the restart`)
  setState({ status: 'idle', statusNote: '', tier: null, model: null, effort: null })
  // what waited for hours is not worth a run now
  const old = openEvents(RAVEN_ID).filter((e) => Date.now() - Date.parse(e.createdAt) > STALE_EVENT_MS)
  if (old.length) claimEvents(RAVEN_ID, 'expired', old.map((e) => e.id))

  setRavenNoticeHandler((n, o) => { postNotice(n, o) })
  setRavenPoster((text, opts) => { ensureRavenChannel(); ravenMessage(text, { refs: opts?.refs, meta: opts?.meta, push: opts?.push }) })
  setRavenWaker((kind, payload) => queueRavenEvent(kind, payload, Number(payload.hop) || 0))
  onBriefWritten(postBrief)
  try { startRavenTools() } catch (e) { console.error('[raven] tools:', (e as Error).message) }

  const prune = setInterval(() => {
    try { pruneRavenFiles() } catch (e) { console.error('[raven] prune:', (e as Error).message) }
  }, 6 * 3_600_000)
  prune.unref?.()
  setTimeout(() => { try { pruneRavenFiles() } catch { /* next time */ } }, 60_000).unref?.()
  if (openEvents(RAVEN_ID).length) wake(3_000)
  console.log(`[raven] started (${features.length} feature${features.length === 1 ? '' : 's'} with Raven parts)`)
}
