import { askClaude, extractJson } from '../claudeCli.js'
import type { RavenEffort, RavenTier } from './types.js'

// Which model and effort a Raven run gets. Before a run Brendon woke, one
// quick call on the haiku tier reads his message and picks the tier and the
// effort the work needs; runs nobody asked for (relays, agent answers,
// follow-ups) skip it and run on sonnet/low.
//
// The tier to model id map comes from RAVEN_MODELS (JSON). Each tier has a
// fallback id known to work on odin's CLI: a run that fails with an
// unknown-model error is retried once on it, and the bad id is remembered
// until the process restarts.

export const TIERS: RavenTier[] = ['haiku', 'sonnet', 'opus']
export const ROUTER_EFFORTS: RavenEffort[] = ['low', 'medium', 'high', 'xhigh']

const DEFAULT_MODELS: Record<RavenTier, string> = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' }
const FALLBACK_MODELS: Record<RavenTier, string> = { haiku: 'claude-haiku-4-5-20251001', sonnet: 'claude-sonnet-5', opus: 'claude-opus-5-5' }
const MODEL_ID_RE = /^[a-z0-9][a-z0-9.\-[\]]{2,80}$/i
const ROUTER_TIMEOUT_MS = Number(process.env.RAVEN_ROUTER_TIMEOUT_MS || 20_000)

const bad = new Set<string>()

function configured(): Record<RavenTier, string> {
  const out = { ...DEFAULT_MODELS }
  const raw = process.env.RAVEN_MODELS
  if (!raw) return out
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    for (const t of TIERS) if (typeof o[t] === 'string' && MODEL_ID_RE.test(o[t] as string)) out[t] = o[t] as string
  } catch {
    console.error('[raven] RAVEN_MODELS is not valid JSON; using the defaults')
  }
  return out
}

/** The model id a tier runs on now: the configured one, or its fallback once the configured one proved unknown. */
export function modelFor(tier: RavenTier): string {
  const want = configured()[tier]
  return bad.has(want) ? FALLBACK_MODELS[tier] : want
}

/** The id to retry on after `model` failed as unknown, or null when there is nothing else to try. */
export function fallbackFor(tier: RavenTier, model: string): string | null {
  const f = FALLBACK_MODELS[tier]
  return f !== model && !bad.has(f) ? f : null
}

export function markBadModel(id: string): void {
  if (!bad.has(id)) console.warn(`[raven] model ${id} is unknown to the CLI; using the fallback until restart`)
  bad.add(id)
}

export const badModels = (): string[] => [...bad]

/** An error's message plus what the CLI printed (ClaudeCliError.detail), for the checks below. */
export const errorText = (e: unknown): string => `${(e as Error)?.message ?? ''}\n${(e as { detail?: string })?.detail ?? ''}`

/** The CLI's words for a model it does not know or the account cannot use. */
export function isUnknownModelError(msg: string): boolean {
  return /selected model|not_found_error|unknown model|invalid model|model\W{1,3}[\w.\-[\]]+\W{0,3} (?:is )?(?:not found|does not exist|may not exist|not available|not supported)/i.test(msg)
}

/** The CLI refusing the --effort flag itself, or the level given. */
export function isEffortError(msg: string): boolean {
  return /effort/i.test(msg) && /unknown option|invalid|allowed choices|not supported|unrecognized/i.test(msg)
}

// --effort: passed on every run. Should the CLI refuse the flag, or one level
// (an older CLI without xhigh), the run is retried without it or a level lower,
// and that is remembered until restart.
let effortFlag = true
const badEfforts = new Set<RavenEffort>()
const EFFORT_DOWN: Record<RavenEffort, RavenEffort | null> = { max: 'xhigh', xhigh: 'high', high: 'medium', medium: 'low', low: null }

/** The effort to pass for a wanted one, or null to leave the flag off. */
export function effortFor(e: RavenEffort): RavenEffort | null {
  if (!effortFlag) return null
  let cur: RavenEffort | null = e
  while (cur && badEfforts.has(cur)) cur = EFFORT_DOWN[cur]
  return cur
}

/** The CLI refused --effort (or this level): remember it and return what to retry with. */
export function effortRefused(msg: string, e: RavenEffort): RavenEffort | null {
  if (/unknown option|unrecognized/i.test(msg)) {
    effortFlag = false
    console.warn('[raven] the CLI does not take --effort; runs go without it until restart')
    return null
  }
  badEfforts.add(e)
  console.warn(`[raven] the CLI refused effort ${e}; using a lower one until restart`)
  return effortFor(e)
}

/** "Sonnet 5.5" for claude-sonnet-5-5, "Haiku 4.5" for claude-haiku-4-5-20251001. */
export function modelLabel(id: string | null | undefined): string {
  if (!id) return ''
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id)
  if (!m) return id
  return `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
}

export type Route = { tier: RavenTier; effort: RavenEffort; why: string; routed: boolean }

export const DEFAULT_ROUTE: Route = { tier: 'sonnet', effort: 'medium', why: 'default', routed: false }
export const RELAY_ROUTE: Route = { tier: 'sonnet', effort: 'low', why: 'relay', routed: false }

function routerPrompt(text: string, files: number): string {
  return [
    "You route messages for Raven, Brendon's assistant. Pick the model tier and the effort the work in his message needs.",
    '- haiku + low: a quick fact, a greeting, chit-chat, a yes or no, a status one look answers.',
    '- sonnet + medium: normal tasks and tool use: look something up, start or message a session, add a task, request a movie, read a file or a photo.',
    '- opus + high: planning, debugging, multi-step orchestration across sessions or agents, careful writing he will send to someone.',
    '- opus + xhigh: the hardest of those: a long investigation or a big plan where every step must be right.',
    'Answer with only this JSON and nothing else: {"tier":"haiku|sonnet|opus","effort":"low|medium|high|xhigh","why":"at most 12 words"}',
    '',
    'His message:',
    '<<<',
    text.slice(0, 4000) || '(no text)',
    '>>>',
    files ? `He attached ${files} file${files === 1 ? '' : 's'}.` : '',
  ].join('\n').trim()
}

/** Reads a router answer; null when it is not a usable choice. */
export function parseRoute(answer: string): Route | null {
  const j = extractJson(answer) as { tier?: unknown; effort?: unknown; why?: unknown } | null
  if (!j) return null
  const tier = String(j.tier ?? '').toLowerCase() as RavenTier
  let effort = String(j.effort ?? '').toLowerCase() as RavenEffort
  if (effort === 'max') effort = 'xhigh'
  if (!TIERS.includes(tier) || !ROUTER_EFFORTS.includes(effort)) return null
  return { tier, effort, why: String(j.why ?? '').replace(/\s+/g, ' ').trim().slice(0, 120), routed: true }
}

/**
 * The router: one quick haiku call within 20 s. Any failure (timeout, no
 * credential, an answer that is not the JSON) means sonnet/medium.
 */
export async function routeMessage(text: string, opts: { files?: number; signal?: AbortSignal } = {}): Promise<Route> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ROUTER_TIMEOUT_MS)
  const stop = () => ac.abort()
  opts.signal?.addEventListener('abort', stop, { once: true })
  const t0 = Date.now()
  try {
    const prompt = routerPrompt(text, opts.files ?? 0)
    let model = modelFor('haiku')
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // the abort ends it on time; the CLI's own limit sits past it so the two never race
        const answer = await askClaude(prompt, { model, timeoutMs: ROUTER_TIMEOUT_MS + 5_000, signal: ac.signal })
        return parseRoute(answer) ?? { ...DEFAULT_ROUTE, why: 'router answer unreadable' }
      } catch (e) {
        const next = isUnknownModelError(errorText(e)) ? fallbackFor('haiku', model) : null
        if (next && !ac.signal.aborted) {
          markBadModel(model)
          model = next
          continue
        }
        return { ...DEFAULT_ROUTE, why: ac.signal.aborted ? 'router timed out' : 'router failed' }
      }
    }
    return { ...DEFAULT_ROUTE, why: 'router failed' }
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', stop)
  }
}
