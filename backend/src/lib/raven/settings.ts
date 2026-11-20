import { AgentError, bump, getKv, setKv } from '../agentsStore.js'
import { isModelKey, modelKeys, ravenModels, routeMessage, type RavenModelInfo } from './models.js'
import type { RavenEffort, RavenPickEffort, RavenRule, RavenRuleKey, RavenSettings, RavenTier } from './types.js'

// Brendon's model and effort pick for Raven, set in the Raven tab on any
// device. It lives in agents.sqlite (kv `raven:settings`), so the phone, the
// iPad and the desktop show the same pick, and every run on odin reads it when
// it starts. Each of the two is a fixed choice or Automatic; Automatic follows
// his rules: what a simple message gets, a complex one, one that came by voice
// (Siri), and a run he did not start (a relay, an agent's answer, a follow-up).

const KEY = 'raven:settings'

export const PICK_EFFORTS: RavenPickEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
export const RULE_KEYS: RavenRuleKey[] = ['simple', 'complex', 'voice', 'background']

export const DEFAULT_RAVEN_SETTINGS: RavenSettings = {
  model: 'auto',
  effort: 'auto',
  rules: {
    // Sonnet, not Haiku: a quick action still runs tools, and Haiku left him with "(no reply)" on 2026-11-19
    simple: { model: 'sonnet', effort: 'low' },
    complex: { model: 'opus', effort: 'high' },
    // Siri waits 55 s for the spoken answer: no router call, the fast pair
    voice: { model: 'sonnet', effort: 'low' },
    background: { model: 'sonnet', effort: 'low' },
  },
}

const isTier = (v: unknown): v is RavenTier => isModelKey(v)
const isPickEffort = (v: unknown): v is RavenPickEffort => PICK_EFFORTS.includes(v as RavenPickEffort)
const clone = (s: RavenSettings): RavenSettings => ({ ...s, rules: Object.fromEntries(RULE_KEYS.map((k) => [k, { ...s.rules[k] }])) as RavenSettings['rules'] })

/** The pick now: what was saved, every bad or missing part replaced by the default. */
export function ravenSettings(): RavenSettings {
  const out = clone(DEFAULT_RAVEN_SETTINGS)
  let saved: Partial<{ model: unknown; effort: unknown; rules: Record<string, Partial<Record<keyof RavenRule, unknown>>> }> = {}
  try {
    saved = JSON.parse(getKv(KEY) ?? '{}') ?? {}
  } catch { /* the defaults */ }
  if (saved.model === 'auto' || isTier(saved.model)) out.model = saved.model
  if (saved.effort === 'auto' || isPickEffort(saved.effort)) out.effort = saved.effort
  for (const k of RULE_KEYS) {
    const r = saved.rules?.[k]
    if (isTier(r?.model)) out.rules[k].model = r.model
    if (isPickEffort(r?.effort)) out.rules[k].effort = r.effort
  }
  return out
}

/**
 * Change part of the pick: `model`, `effort`, any rule's model or effort, or `reset: true` for the rules' defaults
 * (the pick itself stays). A value it does not know is refused with a 400 and nothing changes.
 */
export function setRavenSettings(input: unknown): RavenSettings {
  const b = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const next = ravenSettings()
  if (b.reset === true) next.rules = clone(DEFAULT_RAVEN_SETTINGS).rules
  if (b.model !== undefined) {
    if (b.model !== 'auto' && !isTier(b.model)) throw new AgentError(400, `model must be auto or one of ${modelKeys().join(', ')}`)
    next.model = b.model
  }
  if (b.effort !== undefined) {
    if (b.effort !== 'auto' && !isPickEffort(b.effort)) throw new AgentError(400, `effort must be auto or one of ${PICK_EFFORTS.join(', ')}`)
    next.effort = b.effort
  }
  if (b.rules !== undefined) {
    if (!b.rules || typeof b.rules !== 'object') throw new AgentError(400, 'rules must be an object')
    for (const [k, v] of Object.entries(b.rules as Record<string, unknown>)) {
      if (!RULE_KEYS.includes(k as RavenRuleKey)) throw new AgentError(400, `no rule called ${k.slice(0, 40)}`)
      const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
      if (r.model !== undefined && !isTier(r.model)) throw new AgentError(400, `the ${k} rule's model must be one of ${modelKeys().join(', ')}`)
      if (r.effort !== undefined && !isPickEffort(r.effort)) throw new AgentError(400, `the ${k} rule's effort must be one of ${PICK_EFFORTS.join(', ')}`)
      if (isTier(r.model)) next.rules[k as RavenRuleKey].model = r.model
      if (isPickEffort(r.effort)) next.rules[k as RavenRuleKey].effort = r.effort
    }
  }
  setKv(KEY, JSON.stringify(next))
  // every open app re-reads Raven through the Messages long-poll
  bump()
  return next
}

/** What the app's picker shows: the pick and the models, each with why it is refused right now. */
export const ravenPickView = (): { settings: RavenSettings; models: RavenModelInfo[] } => ({ settings: ravenSettings(), models: ravenModels() })

/** The model, effort and reason one run gets. `rule` is the automatic rule that chose any of it. */
export type Route = { tier: RavenTier; effort: RavenEffort; why: string; routed: boolean; rule?: RavenRuleKey }

/** The router has a call to make: he wrote (not by voice) and the model or the effort is automatic. */
export const needsRouter = (s: RavenSettings, voice: boolean): boolean => !voice && (s.model === 'auto' || s.effort === 'auto')

/**
 * The route for one run. A run he did not start follows the background rule. His message with both fixed runs on
 * them; otherwise the voice rule (Siri) or the rule the router sorted it into fills what is automatic.
 */
export async function chooseRoute(s: RavenSettings, input: { fromBrendon: boolean; voice: boolean; text: string; files: number; signal?: AbortSignal }): Promise<Route> {
  if (!input.fromBrendon) {
    const r = s.rules.background
    return { tier: r.model, effort: r.effort, why: 'relay', routed: false, rule: 'background' }
  }
  const model = s.model === 'auto' ? null : s.model
  const effort = s.effort === 'auto' ? null : s.effort
  if (model && effort) return { tier: model, effort, why: 'your pick', routed: false }
  let rule: RavenRuleKey = 'voice'
  let why = 'a voice message'
  let routed = false
  if (!input.voice) {
    const sorted = await routeMessage(input.text, { files: input.files, signal: input.signal })
    rule = sorted.kind
    why = sorted.why
    routed = sorted.routed
  }
  const r = s.rules[rule]
  return { tier: model ?? r.model, effort: effort ?? r.effort, why, routed, rule }
}
