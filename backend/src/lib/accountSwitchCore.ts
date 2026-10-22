// The account switcher's decisions, as pure functions: no file, network,
// clock or tmux access in here, so scripts/accountSwitchSmoke.mts can test
// every rule with plain inputs. lib/accountSwitch.ts does the I/O.
//
// The model, from the 2026-10-18 investigation:
//   - Each account has ONE long-lived pool token (`claude setup-token`: one
//     year, inference only, no refresh token). Nothing ever refreshes it, so
//     any number of processes can share it with no rotation risk.
//   - A host has ONE live credential file every terminal on it reads. thor:
//     C:\Users\Brendon\.claude\.credentials.json. odin: the store that
//     CLAUDE_SECURESTORAGE_CONFIG_DIR points the Valkyrie odin panes at.
//   - Claude Code re-reads that file before each request when its mtime
//     changed, so swapping the pool token in moves running AND new sessions.
//   - A pane that already stopped on the limit sits armed until the reset and
//     does not notice the swap. Typing a line into it runs the turn on the new
//     token, which is what the nudge does, and only into an empty prompt.

export type HostName = 'thor' | 'odin'
export const HOSTS: HostName[] = ['thor', 'odin']
export const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/

export type Quota = {
  sessionPct: number
  weeklyPct: number
  sessionResetsAt: string | null
  weeklyResetsAt: string | null
  status: string | null
}

// Where a reading came from: the switcher's own probe with the pool token,
// or the backend's /api/ai-usage cache (the per-account grants it polls).
export type QuotaRead = { quota: Quota; at: number; source: 'probe' | 'usage' }

// Who wrote the host's live credential file:
//   pool        a pool token this switcher put there
//   grant       a full sign-in with a refresh token: someone ran /login
//   unknown     a token that is in no vault entry
//   missing     no file, or no claudeAiOauth in it
//   unreachable the host could not be asked (thor asleep, ssh down)
export type Owner = 'pool' | 'grant' | 'unknown' | 'missing' | 'unreachable'

export type SwitchConfig = {
  enabled: boolean
  dryRun: boolean
  hosts: Record<HostName, boolean>
  // Proactive trigger on the active account's 5-hour window.
  thresholdPct: number
  // A target's 5-hour window must be below this.
  targetMaxPct: number
  // An account at or over this weekly percentage is never a target, and an
  // active account that reaches it is switched away from.
  weeklyMaxPct: number
  // Between two proactive switches on one host.
  minIntervalMin: number
  // Between any two switches on one host, a hard limit included.
  hardFloorSec: number
  // The active account's reading must be this fresh to act on.
  quotaFreshSec: number
  // A candidate's reading older than this ranks behind fresh ones.
  candidateFreshMin: number
  nudge: boolean
  nudgeText: string
  // Tie-break preference, account ids.
  order: string[]
  // Picked only when nothing else qualifies (the Pro seat).
  lastResort: string[]
  // Never picked.
  exclude: string[]
}

// Claude Code's own text for a resumed limit wait. One line, no newline.
export const DEFAULT_NUDGE =
  'Your claude.ai usage is available again before the usage-limit reset. Continue the task you were working on when the limit was reached; do not repeat work that is already complete.'

// Ships disabled and in dry run. thor on, odin off: odin panes only read the
// switcher's store after the ODIN_WRAP change is deployed.
export const DEFAULT_CONFIG: SwitchConfig = {
  enabled: false,
  dryRun: true,
  hosts: { thor: true, odin: false },
  thresholdPct: 98,
  targetMaxPct: 90,
  weeklyMaxPct: 98,
  minIntervalMin: 10,
  hardFloorSec: 60,
  quotaFreshSec: 180,
  candidateFreshMin: 20,
  nudge: true,
  nudgeText: DEFAULT_NUDGE,
  order: [],
  lastResort: [],
  exclude: [],
}

const num = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  if (!Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, Math.round(n)))
}
const ids = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && ACCOUNT_ID_RE.test(x)) : []

// Anything that is not a valid value falls back to the default, so a typo in
// config.json can never switch on what it did not name.
export function normalizeConfig(raw: unknown): SwitchConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const d = DEFAULT_CONFIG
  const hostsRaw = (r.hosts && typeof r.hosts === 'object' ? r.hosts : {}) as Record<string, unknown>
  const thresholdPct = num(r.thresholdPct, 50, 100, d.thresholdPct)
  const targetMaxPct = Math.min(num(r.targetMaxPct, 10, 99, d.targetMaxPct), thresholdPct - 1)
  const text = typeof r.nudgeText === 'string' ? r.nudgeText.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 400) : ''
  return {
    enabled: r.enabled === true,
    dryRun: r.dryRun !== false,
    hosts: {
      thor: typeof hostsRaw.thor === 'boolean' ? hostsRaw.thor : d.hosts.thor,
      odin: typeof hostsRaw.odin === 'boolean' ? hostsRaw.odin : d.hosts.odin,
    },
    thresholdPct,
    targetMaxPct,
    weeklyMaxPct: num(r.weeklyMaxPct, 50, 100, d.weeklyMaxPct),
    minIntervalMin: num(r.minIntervalMin, 1, 240, d.minIntervalMin),
    hardFloorSec: num(r.hardFloorSec, 15, 3600, d.hardFloorSec),
    quotaFreshSec: num(r.quotaFreshSec, 30, 1800, d.quotaFreshSec),
    candidateFreshMin: num(r.candidateFreshMin, 1, 240, d.candidateFreshMin),
    nudge: r.nudge !== false,
    nudgeText: text || d.nudgeText,
    order: ids(r.order),
    lastResort: ids(r.lastResort),
    exclude: ids(r.exclude),
  }
}

// The unified rate-limit headers every /v1/messages answer carries, 429s
// included. Same reading aiUsage.ts takes from the backend's own probes.
export function parseRateLimitHeaders(get: (name: string) => string | null): Quota | null {
  const s = get('anthropic-ratelimit-unified-5h-utilization')
  const w = get('anthropic-ratelimit-unified-7d-utilization')
  const status = get('anthropic-ratelimit-unified-status')
  if (!s && !w && !status) return null
  const pct = (v: string | null) => {
    const n = Number(v ?? 0)
    return Math.max(0, Math.min(100, Math.round(Number.isFinite(n) ? n * 100 : 0)))
  }
  const iso = (v: string | null) => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null
  }
  const claim = get('anthropic-ratelimit-unified-representative-claim')
  let sessionPct = pct(s)
  let weeklyPct = pct(w)
  // A rejection without utilization headers still names the window it hit.
  if (status === 'rejected' && !s && claim === 'five_hour') sessionPct = 100
  if (status === 'rejected' && !w && claim === 'seven_day') weeklyPct = 100
  return {
    sessionPct,
    weeklyPct,
    sessionResetsAt: iso(get('anthropic-ratelimit-unified-5h-reset')) ?? (claim === 'five_hour' ? iso(get('anthropic-ratelimit-unified-reset')) : null),
    weeklyResetsAt: iso(get('anthropic-ratelimit-unified-7d-reset')) ?? (claim === 'seven_day' ? iso(get('anthropic-ratelimit-unified-reset')) : null),
    status,
  }
}

// ------------------------------------------------------------- quota math --

const resetPassed = (iso: string | null, now: number): boolean => {
  if (!iso) return false
  const t = Date.parse(iso)
  return Number.isFinite(t) && t <= now
}

// A window whose reset time has passed is empty, whatever the last reading said.
export function effectiveSession(q: Quota, now: number): number {
  return resetPassed(q.sessionResetsAt, now) ? 0 : q.sessionPct
}
export function effectiveWeekly(q: Quota, now: number): number {
  return resetPassed(q.weeklyResetsAt, now) ? 0 : q.weeklyPct
}

// The server refused requests at that reading, or a window is full.
export function hardLimited(q: Quota, now: number): boolean {
  const s = effectiveSession(q, now)
  const w = effectiveWeekly(q, now)
  if (s >= 100 || w >= 100) return true
  if (q.status !== 'rejected') return false
  // A rejection is over once every window that could have caused it reset.
  const sessionOver = resetPassed(q.sessionResetsAt, now)
  const weeklyOver = resetPassed(q.weeklyResetsAt, now) || w < 90
  return !(sessionOver && weeklyOver)
}

export type Trigger = { hard: boolean; why: string }

export function activeTrigger(q: Quota, cfg: SwitchConfig, now: number): Trigger | null {
  if (hardLimited(q, now)) return { hard: true, why: 'limit reached' }
  const w = effectiveWeekly(q, now)
  if (w >= cfg.weeklyMaxPct) return { hard: false, why: `weekly at ${w}%` }
  const s = effectiveSession(q, now)
  if (s >= cfg.thresholdPct) return { hard: false, why: `session at ${s}%` }
  return null
}

// --------------------------------------------------------------- accounts --

export type TokenView = { present: boolean; dead: boolean; expiresAt: number | null }
export type AccountView = { id: string; label: string; token: TokenView; quota: QuotaRead | null }

export type Eligibility = {
  ok: boolean
  why: string
  // 100 - effective session percentage; null when there is no reading.
  room: number | null
  fresh: boolean
  // When this account becomes usable again, for the "every account is near
  // its limit" message. null when unknown or already usable.
  reliefAt: number | null
}

export function eligibility(a: AccountView, cfg: SwitchConfig, now: number): Eligibility {
  const no = (why: string, reliefAt: number | null = null): Eligibility => ({ ok: false, why, room: null, fresh: false, reliefAt })
  if (cfg.exclude.includes(a.id)) return no('excluded in config')
  if (!a.token.present) return no('no pool token')
  if (a.token.dead) return no('pool token rejected')
  if (a.token.expiresAt !== null && a.token.expiresAt <= now + 60_000) return no('pool token expired')
  if (!a.quota) return { ok: true, why: 'no usage reading yet', room: null, fresh: false, reliefAt: null }
  const q = a.quota.quota
  const fresh = now - a.quota.at <= cfg.candidateFreshMin * 60_000
  const s = effectiveSession(q, now)
  const w = effectiveWeekly(q, now)
  const t = (iso: string | null) => (iso && Number.isFinite(Date.parse(iso)) ? Date.parse(iso) : null)
  if (w >= cfg.weeklyMaxPct) return no(`weekly at ${w}%`, t(q.weeklyResetsAt))
  if (hardLimited(q, now)) return no('at its limit', t(q.sessionResetsAt))
  if (s >= cfg.targetMaxPct) return no(`session at ${s}%`, t(q.sessionResetsAt))
  return { ok: true, why: fresh ? 'ok' : 'ok (reading is old)', room: 100 - s, fresh, reliefAt: null }
}

export type Ranked = { id: string; ok: boolean; why: string }
export type TargetPick = { target: AccountView | null; ranked: Ranked[]; earliestRelief: { id: string; at: number } | null }

// The live account with the most room on its 5-hour window. Fresh readings
// beat old or missing ones, weekly room breaks ties, then config order. The
// last-resort accounts (the Pro seat) come after every other usable one.
export function pickTarget(accounts: AccountView[], activeId: string | null, cfg: SwitchConfig, now: number): TargetPick {
  const rows = accounts.map((a) => ({ a, e: eligibility(a, cfg, now) }))
  const orderIdx = (id: string) => {
    const i = cfg.order.indexOf(id)
    return i < 0 ? Number.MAX_SAFE_INTEGER : i
  }
  const weekly = (a: AccountView) => (a.quota ? effectiveWeekly(a.quota.quota, now) : 100)
  const cands = rows
    .filter((r) => r.a.id !== activeId && r.e.ok)
    .sort((x, y) => {
      const lx = cfg.lastResort.includes(x.a.id) ? 1 : 0
      const ly = cfg.lastResort.includes(y.a.id) ? 1 : 0
      if (lx !== ly) return lx - ly
      const kx = x.e.room !== null && x.e.fresh ? 0 : x.e.room !== null ? 1 : 2
      const ky = y.e.room !== null && y.e.fresh ? 0 : y.e.room !== null ? 1 : 2
      if (kx !== ky) return kx - ky
      const rx = x.e.room ?? -1
      const ry = y.e.room ?? -1
      if (rx !== ry) return ry - rx
      const wx = weekly(x.a)
      const wy = weekly(y.a)
      if (wx !== wy) return wx - wy
      const ox = orderIdx(x.a.id)
      const oy = orderIdx(y.a.id)
      if (ox !== oy) return ox - oy
      return x.a.id < y.a.id ? -1 : x.a.id > y.a.id ? 1 : 0
    })
  let earliest: { id: string; at: number } | null = null
  for (const r of rows) {
    if (r.e.reliefAt !== null && r.e.reliefAt > now && (!earliest || r.e.reliefAt < earliest.at)) {
      earliest = { id: r.a.id, at: r.e.reliefAt }
    }
  }
  const ranked: Ranked[] = [
    ...cands.map((r) => ({ id: r.a.id, ok: true, why: r.e.why })),
    ...rows.filter((r) => !cands.includes(r)).map((r) => ({
      id: r.a.id,
      ok: false,
      why: r.a.id === activeId ? 'active now' : r.e.why,
    })),
  ]
  return { target: cands[0]?.a ?? null, ranked, earliestRelief: earliest }
}

// --------------------------------------------------------------- decision --

export type HostView = {
  host: HostName
  enabled: boolean
  active: string | null
  owner: Owner | null
  paused: boolean
  pausedReason: string | null
  // The last applied switch, or the last dry-run decision in dry run.
  lastSwitchAt: number | null
}

export type LimitKind = 'session' | 'weekly' | 'opus' | 'sonnet' | 'fable' | 'generic'
export type LimitEvent = { at: number; limit: LimitKind }

export type Decision =
  | { action: 'none'; reason: string }
  | { action: 'blocked'; reason: string; to?: string }
  | { action: 'exhausted'; reason: string; earliestRelief: { id: string; at: number } | null }
  | { action: 'switch'; from: string | null; to: string; reason: string; hard: boolean }

export type DecideInput = {
  cfg: SwitchConfig
  killed: boolean
  host: HostView
  accounts: AccountView[]
  now: number
  event?: LimitEvent | null
}

export function decide(i: DecideInput): Decision {
  const { cfg, host, accounts, now } = i
  if (i.killed) return { action: 'none', reason: 'kill switch is on' }
  if (!cfg.enabled) return { action: 'none', reason: 'auto-switch is off' }
  if (!cfg.hosts[host.host]) return { action: 'none', reason: `${host.host} is off` }
  if (host.paused) return { action: 'blocked', reason: `paused: ${host.pausedReason ?? 'by hand'}` }
  if (host.owner === 'grant') return { action: 'blocked', reason: 'the live sign-in came from /login, not the pool' }
  if (host.owner === 'unknown') return { action: 'blocked', reason: 'the live token is in no vault entry' }

  if (host.owner === 'unreachable') return { action: 'none', reason: `${host.host} is unreachable` }

  const active = host.active ? accounts.find((a) => a.id === host.active) ?? null : null
  let trigger: Trigger | null = null
  if (!host.active || host.owner === 'missing') {
    trigger = { hard: true, why: 'no live sign-in on the host' }
  } else if (cfg.exclude.includes(host.active)) {
    // disabled in the sign-ins list while a host was on it: move the host off it
    trigger = { hard: true, why: 'account disabled' }
  } else if (i.event) {
    const q = active?.quota
    // A reading taken after the event that shows room means the event came
    // from a request still on the previous token, made before the last switch.
    // The probe reads the account-wide windows only, so it cannot speak for
    // an Opus or Sonnet limit.
    const accountWide = i.event.limit === 'session' || i.event.limit === 'weekly' || i.event.limit === 'generic'
    if (accountWide && q && q.at >= i.event.at && !activeTrigger(q.quota, cfg, now)) {
      return { action: 'none', reason: 'limit event predates the last switch' }
    }
    if (!accountWide && host.lastSwitchAt !== null && i.event.at < host.lastSwitchAt + 30_000) {
      return { action: 'none', reason: 'limit event predates the last switch' }
    }
    if (!q && host.lastSwitchAt !== null && i.event.at < host.lastSwitchAt + 30_000) {
      return { action: 'none', reason: 'limit event predates the last switch' }
    }
    trigger = { hard: true, why: `${i.event.limit === 'generic' ? 'usage' : i.event.limit} limit hit in a session` }
  } else {
    const q = active?.quota
    if (!q || now - q.at > cfg.quotaFreshSec * 1000) return { action: 'none', reason: 'no fresh reading for the active account' }
    trigger = activeTrigger(q.quota, cfg, now)
  }
  if (!trigger) return { action: 'none', reason: 'active account has room' }

  if (host.lastSwitchAt !== null) {
    const since = now - host.lastSwitchAt
    if (since < cfg.hardFloorSec * 1000) return { action: 'blocked', reason: `last switch was ${Math.round(since / 1000)} s ago` }
    if (!trigger.hard && since < cfg.minIntervalMin * 60_000) {
      return { action: 'blocked', reason: `last switch was ${Math.round(since / 60_000)} min ago (minimum ${cfg.minIntervalMin})` }
    }
  }

  const pick = pickTarget(accounts, host.active, cfg, now)
  if (!pick.target) return { action: 'exhausted', reason: `${trigger.why}; no account has room`, earliestRelief: pick.earliestRelief }
  return { action: 'switch', from: host.active, to: pick.target.id, reason: trigger.why, hard: trigger.hard }
}

// ---------------------------------------------------------- limit text ----

// Claude Code's own line, `You've hit your ${name}` (2.1.280 to 2.1.303), where
// name is "session limit" (five_hour), "weekly limit" (seven_day), "Opus
// limit", "Sonnet limit", "Fable limit" (seven_day_overage_included), or plain
// "limit" in headless runs; some paths say "You've reached your" instead.
// Another account fixes every one of those. "usage credit limit", "fast limit"
// and "team's shared budget" are not account limits, so they never match.
// With extra usage on and the org's monthly spend used up (2.1.280,
// 2026-10-22), the line names the spend limit first and the account's own
// window last: "You've hit your org's monthly spend limit · visit
// claude.ai/admin-settings/usage to raise it · your session limit resets
// 3:40pm (America/New_York)". The window is what ran out, so another account
// fixes it. The spend line without a window is the org's budget alone.
// Continue-Stopped.ps1 on thor carries a copy of this and the pane patterns
// below; scripts/fixtures/pane-screens.json keeps the two in step.
const LIMIT_RE = /You[’']ve (?:hit|reached) your (?:(session|weekly|Opus|Sonnet|Fable) )?limit\b/
const SPEND_RE = /You[’']ve (?:hit|reached) your org[’']s monthly spend limit\b.*\byour (session|weekly|Opus|Sonnet|Fable) limit resets\b/

export function classifyLimitText(text: string | null | undefined): LimitKind | null {
  const s = String(text ?? '')
  const m = LIMIT_RE.exec(s) ?? SPEND_RE.exec(s)
  if (!m) return null
  const k = (m[1] ?? '').toLowerCase()
  return k === 'session' || k === 'weekly' || k === 'opus' || k === 'sonnet' || k === 'fable' ? k : 'generic'
}

// --------------------------------------------------------------- panes ----

export type PaneVerdict = {
  limit: LimitKind | null
  armed: boolean
  promptFound: boolean
  promptEmpty: boolean
  nudge: boolean
  why: string
}

const RULE_RE = /^\s*─{8,}\s*$/
const PROMPT_RE = /^\s*[❯>](?:\s(.*))?$/
const BOX_PROMPT_RE = /^\s*│\s*>(?:\s(.*?))?\s*│\s*$/
// The armed banner under the input box: one line on 2.1.283 ("Usage limit
// reached · continuing automatically at 7:49pm"), two on 2.1.303 ("Usage limit
// reached · limit resets 2:30pm", then "Continuing automatically at 2:30pm").
// "when it resets" and "continuing shortly" are the other endings. The first
// 2.1.303 line alone does not say the wait is armed, so it does not count.
const ARMED_RE = /Usage limit reached · continuing (?:automatically|shortly)|^\s*Continuing (?:automatically|shortly)\b/
// Lines that can sit between the limit message and the prompt: the wrapped
// rest of the message, the spinner's summary, the armed banner, and the
// right-aligned hints Claude Code prints over the input box ("Ctrl+Y to paste
// deleted text", "tmux detected · scroll with PgUp/PgDn").
const TAIL_SKIP_RE = /^(?:\s*$|\s*[✻✶✳✢✽·*] |\s*Continuing automatically|\s*● Usage limit reached|\s*⎿\s*$|\s{20,}\S)/

// The decision to type into a pane is made from its screen alone, and only
// says yes when all of these hold:
//   1. Claude Code's prompt is on screen (its ❯ line between two rules), so
//      no dialog, menu or permission prompt is open,
//   2. the prompt holds no text, so nothing half-typed gets submitted,
//   3. the session stopped on an account limit: the armed banner is under the
//      prompt, or the last message above the prompt is the limit line.
export function paneLimitState(screen: string): PaneVerdict {
  const lines = String(screen ?? '').replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+$/, ''))
  const no = (why: string, extra: Partial<PaneVerdict> = {}): PaneVerdict => ({
    limit: null, armed: false, promptFound: false, promptEmpty: false, nudge: false, why, ...extra,
  })

  let p = -1
  let text = ''
  let top = -1
  let bottom = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    const box = BOX_PROMPT_RE.exec(lines[i])
    if (box) {
      p = i
      text = (box[1] ?? '').trim()
      top = i - 1
      bottom = i + 1
      break
    }
    const m = PROMPT_RE.exec(lines[i])
    if (!m) continue
    // The input box: a rule, the ❯ line, any continuation lines, a rule. A ❯
    // line anywhere else is an earlier prompt in the transcript.
    const t = i - 1
    if (t < 0 || !RULE_RE.test(lines[t])) continue
    let b = i + 1
    const extra: string[] = []
    while (b < lines.length && !RULE_RE.test(lines[b])) {
      extra.push(lines[b].trim())
      b++
      if (b - i > 12) break
    }
    if (b >= lines.length || !RULE_RE.test(lines[b])) continue
    p = i
    text = [(m[1] ?? '').trim(), ...extra].join(' ').trim()
    top = t
    bottom = b
    break
  }
  if (p < 0) return no('no Claude prompt on screen')

  const promptEmpty = text === ''
  const below = lines.slice(bottom + 1)
  const armed = below.some((l) => ARMED_RE.test(l))

  // Fullscreen leaves the rows between the last message and the input box
  // blank, so blanks and the other skippable lines do not end the walk; the
  // first line of any other content does.
  let limit: LimitKind | null = null
  for (let i = top - 1; i >= 0 && top - i <= 400; i--) {
    const l = lines[i]
    const k = classifyLimitText(l)
    if (k) {
      limit = k
      break
    }
    if (TAIL_SKIP_RE.test(l)) continue
    // Anything else is newer than any limit line further up.
    break
  }
  if (!limit && armed) {
    // The banner alone names no limit kind, and the limit line may have
    // scrolled off a short screen.
    limit = 'generic'
  }

  const base = { limit, armed, promptFound: true, promptEmpty }
  if (!limit) return { ...base, nudge: false, why: 'not stopped on a limit' }
  if (!promptEmpty) return { ...base, nudge: false, why: 'prompt holds typed text' }
  return { ...base, nudge: true, why: armed ? 'armed at the limit, prompt empty' : 'stopped on the limit, prompt empty' }
}

// ----------------------------------------------------------- credentials --

export type PoolToken = {
  id: string
  accessToken: string
  expiresAt: number | null
  scopes: string[]
  subscriptionType: string | null
  rateLimitTier: string | null
  email: string | null
  label: string | null
}

const toMs = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : null
  }
  return null
}

// A vault entry: <vault>/<id>.json. The token field may be called
// accessToken, token or oauthToken, or sit under claudeAiOauth, so entries
// written by the sign-in automation and by hand both read.
export function parsePoolToken(raw: string, id: string): PoolToken | null {
  let j: Record<string, unknown>
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    j = parsed as Record<string, unknown>
  } catch {
    return null
  }
  const inner = (j.claudeAiOauth && typeof j.claudeAiOauth === 'object' ? j.claudeAiOauth : {}) as Record<string, unknown>
  const tok = [j.accessToken, j.token, j.oauthToken, inner.accessToken].find((v) => typeof v === 'string' && v.trim().length >= 20) as string | undefined
  if (!tok) return null
  // A vault entry that carries a refresh token is a full grant, and a full
  // grant in a shared file is the rotation trap this design exists to avoid.
  if ((typeof j.refreshToken === 'string' && j.refreshToken) || (typeof inner.refreshToken === 'string' && inner.refreshToken)) return null
  const scopesRaw = j.scopes ?? inner.scopes
  const scopes = Array.isArray(scopesRaw) ? scopesRaw.filter((s): s is string => typeof s === 'string') : []
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
  return {
    id,
    accessToken: tok.trim(),
    expiresAt: toMs(j.expiresAt ?? inner.expiresAt),
    scopes: scopes.length ? scopes : ['user:inference'],
    subscriptionType: str(j.subscriptionType ?? inner.subscriptionType),
    rateLimitTier: str(j.rateLimitTier ?? inner.rateLimitTier),
    email: str(j.email),
    label: str(j.label),
  }
}

// The live file with claudeAiOauth replaced by the pool token and every other
// key (mcpOAuth and whatever comes later) kept as it was.
export function buildLiveCredentials(existingRaw: string | null, t: PoolToken, now: number): string {
  let base: Record<string, unknown> = {}
  if (existingRaw) {
    try {
      const parsed = JSON.parse(existingRaw) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = parsed as Record<string, unknown>
    } catch { /* unreadable: start clean, only claudeAiOauth matters */ }
  }
  // No expiry on record: a setup-token lives a year. Claude Code treats a
  // credential within 5 minutes of expiresAt as due for refresh, and with no
  // refresh token that would be a dead session, so never write a short one.
  const expiresAt = t.expiresAt ?? now + 364 * 86_400_000
  const out = {
    ...base,
    claudeAiOauth: {
      accessToken: t.accessToken,
      refreshToken: null,
      expiresAt,
      scopes: t.scopes,
      subscriptionType: t.subscriptionType,
      rateLimitTier: t.rateLimitTier,
    },
  }
  return JSON.stringify(out, null, 2)
}

export function ownerOf(liveRaw: string | null, pool: Pick<PoolToken, 'id' | 'accessToken'>[]): { owner: Owner; account: string | null } {
  if (liveRaw === null || !liveRaw.trim()) return { owner: 'missing', account: null }
  let j: Record<string, unknown>
  try {
    j = JSON.parse(liveRaw) as Record<string, unknown>
  } catch {
    return { owner: 'unknown', account: null }
  }
  const o = (j?.claudeAiOauth ?? null) as Record<string, unknown> | null
  if (!o || typeof o.accessToken !== 'string' || !o.accessToken) return { owner: 'missing', account: null }
  if (typeof o.refreshToken === 'string' && o.refreshToken) return { owner: 'grant', account: null }
  const hit = pool.find((p) => p.accessToken === o.accessToken)
  return hit ? { owner: 'pool', account: hit.id } : { owner: 'unknown', account: null }
}

// -------------------------------------------------------------- helpers ----

export function countRecent(times: number[], now: number, windowMs = 86_400_000): number {
  return times.filter((t) => now - t < windowMs && t <= now).length
}

const ET_TIME = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })
const ET_DAY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' })
const ET_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })

// "7:17 PM ET", or "Tue 7:17 PM ET" when it is not today in New York.
export function fmtET(ms: number | null | undefined, now: number): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'unknown'
  const t = ET_TIME.format(ms)
  return ET_DATE.format(ms) === ET_DATE.format(now) ? `${t} ET` : `${ET_DAY.format(ms)} ${t} ET`
}

export type SwitchNote = {
  host: HostName
  from: { label: string; quota: Quota | null } | null
  to: { label: string; quota: Quota | null }
  reason: string
  dryRun: boolean
  nudged: number
  outside: number
}

const quotaBit = (q: Quota | null, now: number): string => {
  if (!q) return 'no reading'
  const s = effectiveSession(q, now)
  const w = effectiveWeekly(q, now)
  const reset = q.sessionResetsAt ? `, resets ${fmtET(Date.parse(q.sessionResetsAt), now)}` : ''
  return `session ${s}%, weekly ${w}%${reset}`
}

export function switchMessage(n: SwitchNote, now: number): string {
  const head = n.dryRun ? `Dry run: would switch ${n.host}` : `Switched ${n.host}`
  const from = n.from ? ` from ${n.from.label} (${quotaBit(n.from.quota, now)})` : ''
  const parts = [`${head}${from} to ${n.to.label} (${quotaBit(n.to.quota, now)}). Reason: ${n.reason}.`]
  if (!n.dryRun && n.nudged > 0) parts.push(`Continued ${n.nudged} stopped pane${n.nudged === 1 ? '' : 's'}.`)
  // thor's own terminals are continued on thor (Continue-Stopped.ps1, started by the limit hook)
  if (!n.dryRun && n.outside > 0) {
    const s = n.outside === 1 ? '' : 's'
    parts.push(n.host === 'thor'
      ? `${n.outside} session${s} outside Valkyrie hit the limit; thor continues ${n.outside === 1 ? 'it' : 'each one'} once its prompt is empty.`
      : `${n.outside} session${s} outside Valkyrie hit the limit and need${n.outside === 1 ? 's' : ''} a manual continue.`)
  }
  return parts.join(' ')
}

export function exhaustedMessage(host: HostName, activeLabel: string | null, reason: string, relief: { label: string; at: number } | null, now: number): string {
  const stay = activeLabel ? `${host} stays on ${activeLabel}` : `${host} keeps its current sign-in`
  const when = relief ? ` Earliest relief: ${relief.label} at ${fmtET(relief.at, now)}.` : ''
  return `Claude auto-switch: ${reason}, so ${stay}.${when}`
}

export function pausedMessage(host: HostName, why: string): string {
  return `Claude auto-switch paused on ${host}: ${why}. Resume it from AI > Usage when the switcher should take over again.`
}
