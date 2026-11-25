import { askClaude, extractJson } from '../claudeCli.js'
import type { RavenEffort, RavenTier } from './types.js'

// The models a Raven run can use, and the router. Which model and effort a
// run gets is Brendon's pick (lib/raven/settings.ts): fixed, or Automatic.
// Under Automatic, one quick call on the haiku model reads his message and
// sorts it as simple or complex; his rules say what each gets.
//
// The family to model id map comes from RAVEN_MODELS (JSON). Each family has a
// fallback id known to work on odin's CLI: a run that fails because the CLI
// does not know the model, or the account cannot use it (Fable needs usage
// credits), is retried once on the fallback, and the refused id is remembered
// for six hours.

export const ROUTER_EFFORTS: RavenEffort[] = ['low', 'medium', 'high', 'xhigh']

/**
 * The models Raven offers, in the picker's order: the one place to add a model. `key` is what the pick and the rules
 * save (keep it stable), `id` what the CLI gets, `fallback` the id a run moves to when the CLI or the account refuses
 * `id`. RAVEN_MODELS (JSON) changes ids or adds models without a code change: an object of key to id
 * ({"opus":"claude-opus-6"}) or a list of {key, id, fallback?} entries (a new key joins the end of the picker).
 * The keys haiku (the router) and sonnet (the retry after a silent reply) must stay.
 */
const CATALOG: { key: RavenTier; id: string; fallback: string }[] = [
  { key: 'opus', id: 'claude-opus-5-5', fallback: 'claude-opus-5-5' },
  { key: 'sonnet', id: 'claude-sonnet-5-5', fallback: 'claude-sonnet-5' },
  { key: 'haiku', id: 'claude-haiku-5-5', fallback: 'claude-haiku-4-5-20251001' },
  { key: 'fable-5-2', id: 'claude-fable-5-2', fallback: 'claude-opus-5-5' },
  { key: 'fable', id: 'claude-fable-5-1', fallback: 'claude-opus-5-5' },
]
const MODEL_ID_RE = /^[a-z0-9][a-z0-9.\-[\]]{2,80}$/i
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
const ROUTER_TIMEOUT_MS = Number(process.env.RAVEN_ROUTER_TIMEOUT_MS || 20_000)
const BAD_FOR_MS = 6 * 3_600_000

const bad = new Map<string, { at: number; why: string }>()

type Entry = { key: RavenTier; id: string; fallback: string }

/** The catalog with RAVEN_MODELS applied, read each time (the smoke test changes the env between runs). */
function catalog(): Entry[] {
  const out = CATALOG.map((e) => ({ ...e }))
  const raw = process.env.RAVEN_MODELS
  if (!raw) return out
  try {
    const o = JSON.parse(raw) as unknown
    const list: { key?: unknown; id?: unknown; fallback?: unknown }[] = Array.isArray(o)
      ? o
      : Object.entries((o ?? {}) as Record<string, unknown>).map(([key, id]) => ({ key, id }))
    for (const x of list) {
      const key = String(x?.key ?? '')
      if (!KEY_RE.test(key) || typeof x.id !== 'string' || !MODEL_ID_RE.test(x.id)) continue
      const fallback = typeof x.fallback === 'string' && MODEL_ID_RE.test(x.fallback) ? x.fallback : null
      const have = out.find((e) => e.key === key)
      if (have) {
        have.id = x.id
        if (fallback) have.fallback = fallback
      } else {
        out.push({ key, id: x.id, fallback: fallback ?? 'claude-opus-5-5' })
      }
    }
  } catch {
    console.error('[raven] RAVEN_MODELS is not valid JSON; using the built-in models')
  }
  return out
}

const entry = (key: RavenTier): Entry => catalog().find((e) => e.key === key) ?? catalog()[0]

/** Every model key in the picker's order. */
export const modelKeys = (): RavenTier[] => catalog().map((e) => e.key)
export const isModelKey = (v: unknown): v is RavenTier => typeof v === 'string' && modelKeys().includes(v)

/** Why the CLI refused this id in the last six hours, or null. */
export function badWhy(id: string): string | null {
  const b = bad.get(id)
  if (!b) return null
  if (Date.now() - b.at > BAD_FOR_MS) {
    bad.delete(id)
    return null
  }
  return b.why
}
const isBad = (id: string) => badWhy(id) !== null

/** The id a family is configured to run on, refused or not. */
export const wantedModel = (tier: RavenTier): string => entry(tier).id

/** The model id a family runs on now: the configured one, or its fallback while the configured one is refused. */
export function modelFor(tier: RavenTier): string {
  const want = wantedModel(tier)
  return isBad(want) ? entry(tier).fallback : want
}

/** The id to retry on after `model` was refused, or null when there is nothing else to try. */
export function fallbackFor(tier: RavenTier, model: string): string | null {
  const f = entry(tier).fallback
  return f !== model && !isBad(f) ? f : null
}

export function markBadModel(id: string, msg = ''): void {
  const why = /usage credits/i.test(msg) ? 'needs usage credits' : 'not available'
  if (!isBad(id)) console.warn(`[raven] model ${id} was refused (${why}); using the fallback for six hours`)
  bad.set(id, { at: Date.now(), why })
}

export const badModels = (): string[] => [...bad.keys()].filter(isBad)

/** An error's message plus what the CLI printed (ClaudeCliError.detail), for the checks below. */
export const errorText = (e: unknown): string => `${(e as Error)?.message ?? ''}\n${(e as { detail?: string })?.detail ?? ''}`

/** The CLI's words for a model it does not know or the account cannot use ("Fable 5.1 requires usage credits"). */
export function isUnknownModelError(msg: string): boolean {
  return /selected model|not_found_error|unknown model|invalid model|requires usage credits|switch to another model|model\W{1,3}[\w.\-[\]]+\W{0,3} (?:is )?(?:not found|does not exist|may not exist|not available|not supported)/i.test(msg)
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

/** "Sonnet 5.5" for claude-sonnet-5-5, "Haiku 4.5" for claude-haiku-4-5-20251001, "Fable 5.1" for claude-fable-5-1. */
export function modelLabel(id: string | null | undefined): string {
  if (!id) return ''
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id)
  if (!m) return id
  return `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
}

/** One model in the app's picker: its key, the id it runs, its name, why it is refused right now and what runs instead. */
export type RavenModelInfo = { key: RavenTier; id: string; label: string; unavailable?: string; fallback?: string }

export function ravenModels(): RavenModelInfo[] {
  return catalog().map(({ key, id, fallback }) => {
    const why = badWhy(id)
    return { key, id, label: modelLabel(id), ...(why ? { unavailable: why, fallback: modelLabel(fallback) } : {}) }
  })
}

// ------------------------------------------------------------- router ----

export type RouteKind = 'simple' | 'complex'
export type Sorted = { kind: RouteKind; why: string; routed: boolean }

/** What the router does when it cannot read the message: the complex rule, so a hard ask never runs light. */
export const UNSORTED: RouteKind = 'complex'

/** A long paste: its start and its end (his ask is often under or over the pasted text), with how much is left out. */
export function routerSample(text: string, max = 4000): string {
  if (text.length <= max) return text
  const half = Math.floor(max / 2)
  const left = text.length - half * 2
  return `${text.slice(0, half)}\n[… ${left.toLocaleString('en-US')} more characters of the ${text.length.toLocaleString('en-US')} …]\n${text.slice(-half)}`
}

function routerPrompt(text: string, files: number): string {
  return [
    "You sort messages for Raven, Brendon's assistant, so it runs on the right model. Decide if the work his message asks for is simple or complex.",
    '- simple: a quick fact or lookup, a greeting, a yes or no, a status one look answers, one quick action: add to his Amazon or Whole Foods cart, add a task or a reminder, request a movie, start or message one session, read one file or photo.',
    '- complex: several steps that build on each other, work across sessions or agents, a work ticket or client mail, planning, debugging, a careful write-up he will send to someone, a long investigation.',
    'Answer with only this JSON and nothing else: {"kind":"simple|complex","why":"at most 12 words"}',
    '',
    'His message:',
    '<<<',
    routerSample(text) || '(no text)',
    '>>>',
    files ? `He attached ${files} file${files === 1 ? '' : 's'}.` : '',
  ].join('\n').trim()
}

/** Reads a router answer; null when it is not a usable choice. */
export function parseRoute(answer: string): Sorted | null {
  const j = extractJson(answer) as { kind?: unknown; why?: unknown } | null
  if (!j) return null
  const kind = String(j.kind ?? '').toLowerCase().trim()
  if (kind !== 'simple' && kind !== 'complex') return null
  return { kind, why: String(j.why ?? '').replace(/\s+/g, ' ').trim().slice(0, 120), routed: true }
}

/**
 * The router: one quick haiku call within 20 s. Any failure (timeout, no
 * credential, an answer that is not the JSON) sorts the message as complex.
 */
export async function routeMessage(text: string, opts: { files?: number; signal?: AbortSignal } = {}): Promise<Sorted> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ROUTER_TIMEOUT_MS)
  const stop = () => ac.abort()
  opts.signal?.addEventListener('abort', stop, { once: true })
  const unsorted = (why: string): Sorted => ({ kind: UNSORTED, why, routed: false })
  try {
    const prompt = routerPrompt(text, opts.files ?? 0)
    let model = modelFor('haiku')
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // the abort ends it on time; the CLI's own limit sits past it so the two never race
        const answer = await askClaude(prompt, { model, timeoutMs: ROUTER_TIMEOUT_MS + 5_000, signal: ac.signal })
        return parseRoute(answer) ?? unsorted('router answer unreadable')
      } catch (e) {
        const msg = errorText(e)
        const next = isUnknownModelError(msg) ? fallbackFor('haiku', model) : null
        if (next && !ac.signal.aborted) {
          markBadModel(model, msg)
          model = next
          continue
        }
        return unsorted(ac.signal.aborted ? 'router timed out' : 'router failed')
      }
    }
    return unsorted('router failed')
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', stop)
  }
}
