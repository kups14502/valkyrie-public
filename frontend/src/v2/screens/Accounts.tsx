import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Press, toast } from '../kit/ui'
import { Icon, hostIcon, type IconName } from '../kit/icons'
import { ago, useLive, type Live } from '../kit/data'
import { api, apiErrorText } from '../../lib/api'
import './accounts.css'

// AI > Usage, under the usage panels: the Claude account switcher, in plain words.
//
// Set up: what switching still needs (a year-long sign-in per account) and its one action, "Set up
// all accounts", which DMs one sign-in link at a time and shows each account's progress, with the
// box for the code the Claude page shows. Then auto-switch on/off and the threshold, one card per
// host (the account every terminal there uses, or why the switcher has not taken it over yet, with
// Resume), every account's sign-in, and the last switches with their times in ET.
//
// The switcher (backend routes/accountSwitch.ts, routes/accountSignin.ts):
//   GET  /api/account-switch                status: { enabled, dryRun, killed, config,
//        hosts: [{ host, enabled, active: { id, label } | null, owner, adopted, paused, pausedReason,
//                  lastSwitchAt, lastError, vaultIds (thor), next: { id, label } | null, nextReason }],
//        accounts: [{ id, label, email, token: { present, dead, expiresAt }, onThor, identityWarning,
//                     quota: { sessionPct, weeklyPct, ... } | null, eligible, why }],
//        recent: [{ at, kind, host, from, to, reason, ok, fromPct, toPct, nudged, detail }] }
//   POST /api/account-switch/config         { enabled } | { thresholdPct } | { hosts: { <host>: bool } }
//   POST /api/account-switch/switch         { host, account, confirm: true } -> { results: [{ host, ok, error?, nudged }] }
//   POST /api/account-switch/resume         { host } -> { ok, switchedTo, error? } (409 when not ok)
//   POST /api/account-switch/kill           { on: false }
//   GET  /api/account-switch/signin         { requests: [...] newest first, queue, plan: { signin, copy, already } }
//   POST /api/account-switch/signin         { accountId } -> 202 { request } (a one-year token for the vaults)
//   POST /api/account-switch/signin/queue   {} -> 202 { queue } ("Set up all accounts")
//   POST /api/account-switch/signin/queue/cancel
//   POST /api/account-switch/signin/sync-thor   { accountId } -> { ok }
//   POST /api/account-switch/signin/:id/code    { code } (code#state, or the whole callback URL)
//   POST /api/account-switch/signin/:id/dm      sends the link DM again
//   POST /api/account-switch/signin/:id/cancel
// Times are ISO UTC. No route returns a token, a URL or a code; the code a person pastes goes up
// once and the box is cleared. The DM links here with ?signin=<id>, which scrolls to that code box.

type Vars = CSSProperties & Record<`--${string}`, string | number>
const iv = (i: number): Vars => ({ '--i': i })

const KEY = 'accountSwitch'
const SKEY = 'accountSignin2'
const QKEY = ['v2', KEY]
const SQKEY = ['v2', SKEY]
const BASE = '/account-switch'
const HOSTS = ['thor', 'odin'] as const
type HostId = (typeof HOSTS)[number]
/** how long an armed two-tap button waits for its second tap */
const ARM_MS = 4000
const HISTORY_ROWS = 8
const THRESHOLD_MIN = 50
const THRESHOLD_MAX = 100
/** a token this close to its end reads as expiring (the switcher DMs 14 days ahead) */
const EXPIRING_MS = 14 * 86_400_000
/** a finished sign-in (and a finished setup) stays on screen this long */
const RUN_SHOW_MS = 15 * 60_000
/** log kinds the history shows: switches (or a switch that could not happen) and continues */
const SWITCH_KINDS = new Set(['switch', 'manual', 'dry-run', 'error', 'exhausted', 'paused', 'continue'])
const NBSP = String.fromCharCode(160)
const NOT_ADOPTED = /^not adopted/i

// ---------- the view model ----------

type SignIn = 'ok' | 'expiring' | 'expired' | 'missing' | 'dead' | 'unknown'
type Stage = 'starting' | 'browser' | 'needs-code' | 'finishing' | 'done' | 'failed' | 'canceled' | 'expired'
type Next = { accountId: string; label: string | null }

type AcctVM = {
  id: string
  label: string
  email: string | null
  signIn: SignIn
  tokenExpiresAt: number | null
  /** thor's own vault holds this token; null before thor's first check */
  onThor: boolean | null
  identityWarning: string | null
  five: number | null
  week: number | null
  inPool: boolean
  /** why the switcher would not pick it now (eligible false), null when it would */
  why: string | null
}
type HostVM = {
  id: HostId
  accountId: string | null
  accountLabel: string | null
  since: number | null
  /** why auto-switch is paused on this host, null when it is not */
  paused: string | null
  adopted: boolean
  /** this host's own auto-switch (config.hosts), null when unknown */
  auto: boolean | null
  next: Next | null
  nextReason: string | null
  owner: string | null
  error: string | null
}
type EventVM = {
  at: number
  kind: string
  host: string
  from: string | null
  to: string | null
  reason: string | null
  ok: boolean
  error: string | null
  pcts: string | null
  nudged: number
}
type RunVM = {
  id: string
  accountId: string
  stage: Stage
  detail: string | null
  fallback: string | null
  dmSent: boolean
  dmAt: number | null
  waitUntil: number | null
  at: number | null
  vault: { odin: boolean; thor: boolean | null } | null
  identity: string | null
  queue: { n: number; of: number } | null
}
type QueueItemVM = { accountId: string; label: string; kind: 'signin' | 'copy'; status: 'waiting' | 'running' | 'done' | 'failed'; detail: string | null; requestId: string | null }
type QueueVM = {
  id: string
  state: 'running' | 'stopped' | 'finished' | 'canceled'
  reason: string | null
  already: number
  items: QueueItemVM[]
  at: number | null
}
type PlanVM = { signin: string[]; copy: string[]; already: number }
type SigninsVM = { runs: RunVM[]; queue: QueueVM | null; plan: PlanVM | null }

type SwitchVM = {
  /** false when odin has no switcher route (not deployed yet) */
  installed: boolean
  enabled: boolean
  /** the kill switch is set: nothing switches until it is removed */
  killed: boolean
  dryRun: boolean
  threshold: number | null
  hosts: HostVM[]
  accounts: AcctVM[]
  history: EventVM[]
}

type Raw = Record<string, unknown>
const obj = (v: unknown): Raw | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)
const pct = (v: unknown): number | null => {
  const n = num(v)
  return n == null ? null : Math.round(n)
}
/** ISO string or ms epoch to ms, null when neither */
const when = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v) {
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : null
  }
  return null
}
const list = (v: unknown): Raw[] => (Array.isArray(v) ? v.map(obj).filter((x): x is Raw => !!x) : [])
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
/** an id, or { id, label } */
const ref = (v: unknown): { id: string; label: string | null } | null => {
  const o = obj(v)
  const id = o ? str(o.id) : str(v)
  return id ? { id, label: o ? str(o.label) : null } : null
}

const STAGES: readonly Stage[] = ['starting', 'browser', 'needs-code', 'finishing', 'done', 'failed', 'canceled', 'expired']
const runLive = (r: RunVM | null | undefined) => !!r && (r.stage === 'starting' || r.stage === 'browser' || r.stage === 'needs-code' || r.stage === 'finishing')

/** an account's sign-in from its pool token { present, dead, expiresAt } */
function tokenSignIn(t: Raw | null, now: number): SignIn {
  if (!t) return 'unknown'
  if (t.present === false) return 'missing'
  if (t.dead === true) return 'dead'
  const exp = when(t.expiresAt)
  if (exp != null && exp <= now) return 'expired'
  if (exp != null && exp - now < EXPIRING_MS) return 'expiring'
  return 'ok'
}

const NOT_INSTALLED: SwitchVM = { installed: false, enabled: false, killed: false, dryRun: false, threshold: null, hosts: [], accounts: [], history: [] }

/** GET /api/account-switch as the screen shows it. Anything that is not a status reads as "not installed". */
function toSwitchVM(data: unknown, now = Date.now()): SwitchVM {
  const d = obj(data)
  if (!d || (!Array.isArray(d.hosts) && !Array.isArray(d.accounts))) return NOT_INSTALLED
  const cfg = obj(d.config)
  const cfgHosts = obj(cfg?.hosts)
  const exclude = strs(cfg?.exclude)
  const hostsRaw = list(d.hosts)
  const hosts = HOSTS.map((id): HostVM => {
    const h = hostsRaw.find((x) => str(x.host) === id)
    const active = h ? ref(h.active) : null
    const next = h ? ref(h.next) : null
    const auto = h && typeof h.enabled === 'boolean' ? h.enabled : typeof cfgHosts?.[id] === 'boolean' ? (cfgHosts[id] as boolean) : null
    return {
      id,
      accountId: active?.id ?? null,
      accountLabel: active?.label ?? null,
      since: h ? when(h.lastSwitchAt) : null,
      paused: h?.paused === true ? str(h.pausedReason) ?? 'paused' : null,
      adopted: h?.adopted === true,
      auto,
      next: next ? { accountId: next.id, label: next.label } : null,
      nextReason: h ? str(h.nextReason) : null,
      owner: h ? str(h.owner) : null,
      error: h ? str(h.lastError) : null,
    }
  })
  const accounts = list(d.accounts).map((a): AcctVM => {
    const id = str(a.id) ?? '?'
    const token = obj(a.token)
    const q = obj(a.quota)
    return {
      id,
      label: str(a.label) ?? id,
      email: str(a.email),
      signIn: tokenSignIn(token, now),
      tokenExpiresAt: when(token?.expiresAt),
      onThor: bool(a.onThor),
      identityWarning: str(a.identityWarning),
      five: pct(q?.sessionPct),
      week: pct(q?.weeklyPct),
      inPool: !exclude.includes(id),
      why: a.eligible === false ? str(a.why) : null,
    }
  })
  const history = list(d.recent)
    .map((e): EventVM | null => {
      const at = when(e.at)
      const kind = str(e.kind) ?? 'switch'
      if (at == null || !SWITCH_KINDS.has(kind)) return null
      const fp = num(e.fromPct)
      const tp = num(e.toPct)
      return {
        at,
        kind,
        host: str(e.host) ?? 'pool',
        from: str(e.from),
        to: str(e.to),
        reason: str(e.reason),
        ok: e.ok !== false,
        error: str(e.detail),
        pcts: fp != null || tp != null ? `5h ${fp != null ? `${Math.round(fp)}%` : '?'} → ${tp != null ? `${Math.round(tp)}%` : '?'}` : null,
        nudged: num(e.nudged) ?? 0,
      }
    })
    .filter((e): e is EventVM => !!e)
    .sort((a, b) => b.at - a.at)
  const t = num(cfg?.thresholdPct ?? d.thresholdPct)
  return {
    installed: true,
    enabled: d.enabled === true,
    killed: d.killed === true,
    dryRun: d.dryRun === true,
    threshold: t == null ? null : Math.round(t),
    hosts,
    accounts,
    history,
  }
}

/** GET /api/account-switch/signin: the sign-ins newest first, the setup run, and what setup would do now */
function toSignins(data: unknown): SigninsVM {
  const d = obj(data)
  const runs = list(d?.requests)
    .map((r): RunVM | null => {
      const id = str(r.id)
      const accountId = str(r.accountId)
      const stage = str(r.stage)
      if (!id || !accountId || !stage || !(STAGES as readonly string[]).includes(stage)) return null
      const v = obj(r.vault)
      const q = obj(r.queue)
      return {
        id,
        accountId,
        stage: stage as Stage,
        detail: str(r.detail),
        fallback: str(r.fallbackReason),
        dmSent: r.dmSent === true,
        dmAt: when(r.dmAt),
        waitUntil: when(r.waitUntil),
        at: when(r.updatedAt ?? r.startedAt),
        vault: v ? { odin: v.odin === true, thor: bool(v.thor) } : null,
        identity: str(r.identity),
        queue: q && num(q.n) != null && num(q.of) != null ? { n: num(q.n)!, of: num(q.of)! } : null,
      }
    })
    .filter((r): r is RunVM => !!r)
  const qd = obj(d?.queue)
  const qState = str(qd?.state)
  const queue: QueueVM | null = qd && str(qd.id) && (qState === 'running' || qState === 'stopped' || qState === 'finished' || qState === 'canceled')
    ? {
        id: str(qd.id)!,
        state: qState,
        reason: str(qd.reason),
        already: num(qd.already) ?? 0,
        at: when(qd.finishedAt ?? qd.updatedAt),
        items: list(qd.items).map((i): QueueItemVM => ({
          accountId: str(i.accountId) ?? '?',
          label: str(i.label) ?? str(i.accountId) ?? '?',
          kind: i.kind === 'copy' ? 'copy' : 'signin',
          status: i.status === 'running' || i.status === 'done' || i.status === 'failed' ? i.status : 'waiting',
          detail: str(i.detail),
          requestId: str(i.requestId),
        })),
      }
    : null
  const pd = obj(d?.plan)
  const plan: PlanVM | null = pd ? { signin: strs(pd.signin), copy: strs(pd.copy), already: num(pd.already) ?? 0 } : null
  return { runs, queue, plan }
}

const httpStatus = (e: unknown): number | undefined => (e as { response?: { status?: number } } | null)?.response?.status

async function fetchSwitch(): Promise<SwitchVM> {
  try {
    return toSwitchVM((await api.get(BASE)).data)
  } catch (e) {
    // no route on odin yet: a quiet note, not an error
    if (httpStatus(e) === 404) return NOT_INSTALLED
    throw e
  }
}

const NO_SIGNINS: SigninsVM = { runs: [], queue: null, plan: null }

async function fetchSignins(): Promise<SigninsVM> {
  try {
    return toSignins((await api.get(`${BASE}/signin`)).data)
  } catch (e) {
    if (httpStatus(e) === 404) return NO_SIGNINS
    throw e
  }
}

function useSwitch(): Live<SwitchVM> {
  return useLive<SwitchVM>(KEY, fetchSwitch, 15_000, {
    revive: (c) => (obj(c) && Array.isArray((c as SwitchVM).hosts) && Array.isArray((c as SwitchVM).history) ? (c as SwitchVM) : undefined),
  })
}

function useSignins(): Live<SigninsVM> {
  const qc = useQueryClient()
  // a sign-in or a setup in progress is read every 3 s, so its steps and the code box show at once
  const prev = qc.getQueryData<SigninsVM>(SQKEY)
  const busy = !!prev && (prev.runs.some(runLive) || prev.queue?.state === 'running')
  return useLive<SigninsVM>(SKEY, fetchSignins, busy ? 3_000 : 30_000, {
    revive: (c) => (obj(c) && Array.isArray((c as SigninsVM).runs) ? (c as SigninsVM) : undefined),
  })
}

// ---------- writes ----------

/** "500 refused" from a failed write: the status, then the backend's own words */
const why = (e: unknown): string => {
  const status = httpStatus(e)
  const text = apiErrorText(e, (e as Error | null)?.message || 'no answer')
  const short = text.length > 110 ? `${text.slice(0, 109)}…` : text
  return status ? `${status} ${short}` : short
}

/** POSTs a write and reads the status and the sign-ins again, whatever the answer. */
function useWrite() {
  const qc = useQueryClient()
  return async <T = unknown>(path: string, body: Record<string, unknown>): Promise<T> => {
    try {
      return (await api.post<T>(`${BASE}${path}`, body)).data
    } finally {
      void qc.invalidateQueries({ queryKey: QKEY })
      void qc.invalidateQueries({ queryKey: SQKEY })
    }
  }
}

/** A two-tap button's state: the first tap arms, the second (within ARM_MS) fires. */
function useArm(): [boolean, (v: boolean) => void] {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), ARM_MS)
    return () => clearTimeout(t)
  }, [armed])
  return [armed, setArmed]
}

// ---------- formatting (every time in New York time, labeled ET) ----------

const ET = 'America/New_York'
const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit' })
const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: ET, hour: 'numeric', minute: '2-digit' })
const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: ET, month: 'short', day: 'numeric' })
const dateFmt = new Intl.DateTimeFormat('en-US', { timeZone: ET, month: 'short', day: 'numeric', year: 'numeric' })

/** "3:04 PM ET" today, "Oct 17 3:04 PM ET" another day */
const etTime = (ms: number, now = Date.now()): string => {
  const t = timeFmt.format(ms)
  return dayKey.format(ms) === dayKey.format(now) ? `${t} ET` : `${dayFmt.format(ms)} ${t} ET`
}

const label = (s: SwitchVM, id: string | null): string => (id ? s.accounts.find((a) => a.id === id)?.label ?? id : 'none')
const usable = (a: AcctVM) => a.signIn === 'ok' || a.signIn === 'expiring'
/** a token this host can switch to: thor needs it in its own vault too */
const usableOn = (a: AcctVM, h: HostId) => usable(a) && (h !== 'thor' || a.onThor !== false)
const needsSignIn = (a: AcctVM) => a.signIn === 'missing' || a.signIn === 'dead' || a.signIn === 'expired'
const windows = (a: AcctVM | undefined): string | null => {
  if (!a || (a.five == null && a.week == null)) return null
  return [a.five != null && `5h ${a.five}%`, a.week != null && `week ${a.week}%`].filter(Boolean).join(' · ')
}

function signInText(a: AcctVM, now: number): string {
  const until = a.tokenExpiresAt && a.tokenExpiresAt > now ? dateFmt.format(a.tokenExpiresAt) : null
  switch (a.signIn) {
    case 'ok': return until ? `Set up until ${until}` : 'Set up'
    case 'expiring': return until ? `Renew by ${until}` : 'Renew soon'
    case 'expired': return 'Token expired: sign in again'
    case 'missing': return 'Needs a sign-in'
    case 'dead': return 'Token refused: sign in again'
    default: return 'Sign-in unknown'
  }
}

/** What a host card says when the switcher does not own the host's sign-in yet. */
function ownSignIn(h: HostVM): { title: string; text: string } {
  switch (h.owner) {
    case 'grant': return {
      title: 'Its own sign-in',
      text: `${h.id} still uses its normal /login sign-in, so the switcher has not taken over. Resume hands ${h.id} to the switcher.`,
    }
    case 'missing': return h.id === 'odin'
      ? { title: 'Its own sign-ins', text: 'odin terminals still use their own sign-ins, so the switcher has not taken over. Resume hands odin to the switcher.' }
      : { title: 'No sign-in', text: `${h.id} has no Claude sign-in file. Resume gives it a switcher account.` }
    case 'unknown': return {
      title: 'Unknown sign-in',
      text: `${h.id} holds a token the switcher did not make. Resume replaces it with a switcher account.`,
    }
    case 'unreachable': return { title: 'No answer', text: `${h.id} did not answer the last check.` }
    default: return { title: 'Not checked yet', text: 'The switcher has not read this host yet.' }
  }
}

const QUEUE_TERMINAL = new Set(['finished', 'stopped', 'canceled'])

// ---------- the screen part ----------

/** The switcher's controls, shown inside AI > Usage. */
export function Accounts({ now }: { now: number }) {
  const q = useSwitch()
  const si = useSignins()
  const s = q.data
  const signins = si.data ?? NO_SIGNINS

  if (!s || !s.installed) {
    return (
      <section className="va va-one vl-panel vl-build" style={iv(3)} aria-label="Account switching">
        <header className="vc-u-head">
          <Icon name="refresh" size={14} tone="dim" />
          <span className="vc-u-label">Switching</span>
          <Fresh q={q} now={now} />
        </header>
        <div className="va-quiet" data-failed={(q.failed && !s) || undefined}>
          {s ? 'The account switcher is not running on odin yet.'
            : q.failed ? <><Icon name="alert" size={14} tone="acc2" glow />The switcher did not answer: {q.error?.message ?? 'no reply'}.</>
              : <><Icon name="refresh" size={14} tone="dim" className="vl-pulse" />Reading the switcher</>}
        </div>
      </section>
    )
  }

  return (
    <div className="va" aria-label="Account switching">
      <Setup s={s} si={signins} now={now} />
      <AutoPanel s={s} q={q} now={now} />
      {s.hosts.map((h, k) => <HostCard key={h.id} h={h} s={s} now={now} i={5 + k} />)}
      <AccountList s={s} si={signins} now={now} />
      <History s={s} now={now} />
    </div>
  )
}

function Fresh({ q, now }: { q: Live<SwitchVM>; now: number }) {
  if (q.failed) {
    return (
      <span className="vc-fresh" data-failed title={q.error?.message}>
        <Icon name="offline" size={12} tone="acc2" />
        {q.data !== undefined && q.updatedAt ? `switcher unreachable · ${ago(q.updatedAt, now)} old` : 'switcher unreachable'}
      </span>
    )
  }
  if (q.data === undefined) return null
  return (
    <span className="vc-fresh" data-busy={q.isFetching || undefined} title={`switcher read ${ago(q.updatedAt, now)} ago`}>
      <Icon name={q.isFetching ? 'refresh' : 'clock'} size={11} tone={q.isFetching ? 'dim' : 'faint'} />switcher {ago(q.updatedAt, now)}
    </span>
  )
}

// ---------- set up: one sign-in per account per year, one at a time ----------

function Setup({ s, si, now }: { s: SwitchVM; si: SigninsVM; now: number }) {
  const write = useWrite()
  const [sending, setSending] = useState<'start' | 'stop' | null>(null)
  const total = s.accounts.length
  const queue = si.queue
  const running = queue?.state === 'running'
  // what setup would do now: the backend's plan, or the status when the plan has not loaded
  const toSignIn = si.plan ? si.plan.signin.length : s.accounts.filter(needsSignIn).length
  const toCopy = si.plan ? si.plan.copy.length : s.accounts.filter((a) => usable(a) && a.onThor === false).length
  const todo = toSignIn + toCopy
  // an account with a token on odin counts as set up; a missing copy on thor shows in the note
  const ready = Math.max(0, total - toSignIn)
  const recentEnd = !!queue && QUEUE_TERMINAL.has(queue.state) && queue.at != null && now - queue.at < RUN_SHOW_MS
  const liveOther = si.runs.find((r) => runLive(r) && !r.queue) ?? null

  // nothing to do and nothing to report: the pane is not drawn
  if (!running && !todo && !recentEnd) return null

  const start = () => {
    if (sending) return
    setSending('start')
    write<{ queue?: { items?: unknown[] } }>('/signin/queue', {})
      .then((r) => toast((r?.queue?.items?.length ?? 0) ? 'Setup started: watch for the Lil kups DM' : 'Every account is already set up'))
      .catch((e: unknown) => toast(`Setup not started: ${why(e)}`))
      .finally(() => setSending(null))
  }
  const stop = () => {
    if (sending) return
    setSending('stop')
    write('/signin/queue/cancel', {})
      .then(() => toast('Setup stopped'))
      .catch((e: unknown) => toast(`Setup not stopped: ${why(e)}`))
      .finally(() => setSending(null))
  }

  const showQueue = !!queue && (running || recentEnd)
  const allDone = !todo && !running
  // hosts whose own auto-switch is on but that the switcher has not taken over yet
  const toResume = s.hosts.filter((h) => h.auto !== false && !h.adopted).map((h) => h.id)
  const heading = allDone
    ? `All ${total} accounts are set up for switching`
    : `${ready} of ${total} accounts are set up for switching`

  return (
    <section className="va-setup vl-panel vl-build" style={iv(3)} aria-label="Set up accounts" data-done={allDone || undefined}>
      <header className="vc-u-head">
        <Icon name={allDone ? 'done' : 'claude'} size={14} tone={allDone ? 'fg' : 'dim'} glow={allDone || running} />
        <span className="vc-u-label">Set up</span>
        {running && <span className="va-sub">running</span>}
      </header>
      <b className="va-setup-head">{heading}</b>
      {allDone ? (
        <p className="va-explain">
          {toResume.length
            ? `Next: press Resume on ${toResume.join(' and ')} below, so ${toResume.length === 1 ? 'its' : 'their'} terminals use these accounts and switch when one runs low.`
            : 'The switcher can use every account now.'}
        </p>
      ) : (
        <>
          <p className="va-explain">
            Each account needs one sign-in a year. Valkyrie DMs you a link for each account, one at a time: open it in a private
            window, sign in as that account, press Authorize, and paste the code here.
          </p>
          <p className="va-explain va-dim">
            Valkyrie cannot finish this alone: claude.ai shows a captcha to the automated browser, and Valkyrie does not try to get past it.
          </p>
        </>
      )}

      {showQueue && queue && <QueueRows queue={queue} si={si} s={s} now={now} />}
      {queue && queue.state === 'stopped' && recentEnd && queue.reason && (
        <div className="va-warn"><Icon name="alert" size={13} tone="acc2" glow /><span>Stopped: {queue.reason}.</span></div>
      )}

      <div className="va-setup-act">
        {running ? (
          <Press className="va-setup-stop vl-link" disabled={!!sending} onPress={stop}>
            <Icon name="stop" size={13} tone="dim" />{sending === 'stop' ? 'Stopping' : 'Stop setup'}
          </Press>
        ) : todo > 0 ? (
          <>
            <Press
              className="va-setup-go vl-btn"
              disabled={!!sending || !!liveOther}
              aria-busy={sending === 'start' || undefined}
              onPress={start}
            >
              {sending === 'start' ? 'Starting' : queue?.state === 'stopped' ? 'Continue setup' : todo === total ? 'Set up all accounts' : `Set up ${todo} ${todo === 1 ? 'account' : 'accounts'}`}
            </Press>
            <span className="va-setup-note">
              {liveOther ? 'Finish the sign-in below first.' : [toSignIn && `${toSignIn} to sign in`, toCopy && `${toCopy} to copy to thor`].filter(Boolean).join(' · ')}
            </span>
          </>
        ) : null}
      </div>
    </section>
  )
}

const ITEM_ICON: Record<QueueItemVM['status'], IconName> = { waiting: 'clock', running: 'asking', done: 'done', failed: 'alert' }

function QueueRows({ queue, si, s, now }: { queue: QueueVM; si: SigninsVM; s: SwitchVM; now: number }) {
  return (
    <ol className="va-q">
      {queue.items.map((it) => {
        const run = it.requestId ? si.runs.find((r) => r.id === it.requestId) ?? null : null
        const acct = s.accounts.find((a) => a.id === it.accountId)
        const live = it.status === 'running'
        return (
          <li key={it.accountId} className="va-q-item" data-status={it.status}>
            <div className="va-q-row">
              <Icon
                name={ITEM_ICON[it.status]}
                size={13}
                tone={it.status === 'failed' ? 'acc2' : it.status === 'waiting' ? 'dim' : 'fg'}
                glow={live || it.status === 'done'}
                className={live && run?.stage !== 'needs-code' ? 'vl-pulse' : undefined}
              />
              <span className="va-q-name vl-ellipsis">{it.label}</span>
              <em className="va-q-state">{queueItemText(it, run, now)}</em>
            </div>
            {live && run && runLive(run) && <RunBody run={run} email={acct?.email ?? null} label={it.label} now={now} />}
          </li>
        )
      })}
    </ol>
  )
}

function queueItemText(it: QueueItemVM, run: RunVM | null, now: number): string {
  if (it.kind === 'copy') {
    return it.status === 'done' ? 'Copied to thor' : it.status === 'running' ? 'Copying to thor' : it.status === 'failed' ? (it.detail ?? 'Copy failed') : 'Copy to thor next'
  }
  switch (it.status) {
    case 'waiting': return 'Next'
    case 'done': return run?.vault?.thor === false ? 'Set up on odin; thor did not answer' : 'Set up'
    case 'failed': return run?.stage === 'expired' ? 'Timed out' : run?.stage === 'canceled' ? 'Canceled' : `Failed${it.detail ? `: ${it.detail}` : ''}`
    case 'running':
      if (!run) return 'Starting'
      if (run.stage === 'needs-code') return run.waitUntil ? `Waiting for your code until ${etTime(run.waitUntil, now)}` : 'Waiting for your code'
      return run.stage === 'finishing' ? 'Checking the code' : 'Sending the link'
  }
}

// ---------- auto-switch on/off, the threshold, the kill switch ----------

function AutoPanel({ s, q, now }: { s: SwitchVM; q: Live<SwitchVM>; now: number }) {
  const write = useWrite()
  const qc = useQueryClient()
  const [sending, setSending] = useState<'auto' | 'threshold' | 'kill' | null>(null)
  const [draft, setDraft] = useState<number | null>(null)
  const [killArmed, setKillArmed] = useArm()
  const shown = draft ?? s.threshold ?? 98
  const changed = draft != null && draft !== s.threshold

  const toggle = () => {
    if (sending) return
    const on = !s.enabled
    setSending('auto')
    write('/config', { enabled: on })
      .then(() => toast(on ? 'Auto-switch on' : 'Auto-switch off'))
      .catch((e: unknown) => toast(`Auto-switch not changed: ${why(e)}`))
      .finally(() => setSending(null))
  }
  const step = (d: number) => setDraft(Math.max(THRESHOLD_MIN, Math.min(THRESHOLD_MAX, shown + d)))
  const save = () => {
    if (sending || !changed) return
    const v = shown
    setSending('threshold')
    write('/config', { thresholdPct: v })
      // the draft stays until the saved value is on screen, so the number never jumps back
      .then(async () => { toast(`Switches at ${v}% now`); await qc.refetchQueries({ queryKey: QKEY }) })
      .catch((e: unknown) => toast(`Threshold not saved: ${why(e)}`))
      .finally(() => { setDraft(null); setSending(null) })
  }
  const unkill = () => {
    if (sending) return
    if (!killArmed) { setKillArmed(true); return }
    setKillArmed(false)
    setSending('kill')
    write('/kill', { on: false })
      .then(() => toast('Kill switch removed'))
      .catch((e: unknown) => toast(`Kill switch not removed: ${why(e)}`))
      .finally(() => setSending(null))
  }
  const live = s.enabled && !s.killed

  return (
    <section className="va-auto vl-panel vl-build" style={iv(4)} aria-label="Auto-switch" data-on={live || undefined}>
      <header className="vc-u-head">
        <Icon name="refresh" size={14} tone={live ? 'fg' : 'dim'} glow={live} />
        <span className="vc-u-label">Switching</span>
        <Fresh q={q} now={now} />
      </header>
      <div className="va-auto-rows">
        <Press
          className="va-toggle vl-hit"
          role="switch"
          aria-checked={s.enabled}
          aria-busy={sending === 'auto' || undefined}
          aria-label={`Auto-switch ${s.enabled ? 'on' : 'off'}`}
          data-on={s.enabled || undefined}
          disabled={sending === 'auto'}
          onPress={toggle}
        >
          <Icon name="power" size={15} tone={s.enabled ? 'fg' : 'dim'} glow={live} />
          <span className="va-toggle-label">Auto-switch</span>
          <span className="va-toggle-state">{sending === 'auto' ? (s.enabled ? 'Turning off' : 'Turning on') : s.enabled ? 'On' : 'Off'}</span>
          <i className="va-toggle-track" aria-hidden><i /></i>
        </Press>
        <div className="va-thr" role="group" aria-label="Switch threshold">
          <span className="va-thr-label"><Icon name="gauge" size={14} tone="dim" />Switch at 5h</span>
          <Press className="va-thr-step vl-hit" aria-label="Lower the threshold" disabled={!!sending || shown <= THRESHOLD_MIN} onPress={() => step(-1)}>−</Press>
          <b className="va-thr-value" data-changed={changed || undefined} aria-live="polite">{shown}<small>%</small></b>
          <Press className="va-thr-step vl-hit" aria-label="Raise the threshold" disabled={!!sending || shown >= THRESHOLD_MAX} onPress={() => step(1)}>+</Press>
          {changed && (
            <Press className="va-thr-save vl-btn-line" data-lit aria-busy={sending === 'threshold' || undefined} disabled={sending === 'threshold'} onPress={save}>
              {sending === 'threshold' ? 'Saving' : 'Save'}
            </Press>
          )}
        </div>
      </div>
      {s.killed && (
        <div className="va-warn va-kill">
          <Icon name="alert" size={13} tone="acc2" glow />
          <span>Kill switch is set on odin: nothing switches until it is removed.</span>
          <Press
            className="va-unkill vl-btn-line"
            data-armed={killArmed || undefined}
            disabled={sending === 'kill'}
            aria-label={killArmed ? 'Confirm: remove the kill switch' : 'Remove the kill switch'}
            onPress={unkill}
          >
            {sending === 'kill' ? 'Removing' : killArmed ? 'Remove it?' : 'Remove'}
          </Press>
        </div>
      )}
      {s.dryRun && <div className="va-note"><Icon name="alert" size={13} tone="hot" />Dry run: automatic switches are only logged. Switch now is real.</div>}
      {!s.enabled && !s.killed && <div className="va-note">Off: no automatic switch. Switch now still works.</div>}
    </section>
  )
}

// ---------- one host: its account now, its auto-switch, the next pick, Switch now ----------

type SwitchResult = { results?: { host?: string; ok?: boolean; error?: string; nudged?: number }[] }

function HostCard({ h, s, now, i }: { h: HostVM; s: SwitchVM; now: number; i: number }) {
  const write = useWrite()
  const cur = s.accounts.find((a) => a.id === h.accountId)
  const choices = s.accounts.filter((a) => usableOn(a, h.id) && a.id !== h.accountId)
  const anyUsable = s.accounts.some((a) => usableOn(a, h.id))
  const nextAcct = h.next ? s.accounts.find((a) => a.id === h.next!.accountId) : undefined
  const [open, setOpen] = useState(false)
  const [pick, setPick] = useState<string | null>(null)
  const [sending, setSending] = useState<'switch' | 'resume' | null>(null)
  const picked = choices.find((a) => a.id === pick) ?? null
  const own = h.accountId ? null : ownSignIn(h)
  // never taken over: the card explains that, with Resume, instead of a "paused" warning
  const notYet = !h.adopted && !!h.paused && NOT_ADOPTED.test(h.paused)

  const start = () => {
    setPick(h.next && choices.some((a) => a.id === h.next!.accountId) ? h.next.accountId : choices[0]?.id ?? null)
    setOpen(true)
  }
  const confirm = () => {
    if (!picked || sending) return
    const to = picked
    setSending('switch')
    write<SwitchResult>('/switch', { host: h.id, account: to.id, confirm: true })
      .then((r) => {
        const res = r?.results?.find((x) => x.host === h.id) ?? r?.results?.[0]
        if (res && res.ok === false) {
          toast(`Could not switch ${h.id}: ${res.error ?? 'the switcher said no'}`)
          return
        }
        const n = res?.nudged ?? 0
        toast(`${h.id} switched to ${to.label}${n ? ` · ${n} stopped ${n === 1 ? 'pane' : 'panes'} continued` : ''}`)
        setOpen(false)
      })
      .catch((e: unknown) => toast(`Could not switch ${h.id}: ${why(e)}`))
      .finally(() => setSending(null))
  }
  const resume = () => {
    if (sending) return
    setSending('resume')
    write<{ ok?: boolean; switchedTo?: string | null; error?: string }>('/resume', { host: h.id })
      .then((r) => {
        if (r?.ok === false) { toast(`${h.id} not resumed: ${r.error ?? 'the switcher said no'}`); return }
        toast(r?.switchedTo ? `${h.id} now uses ${label(s, r.switchedTo)}` : `${h.id} resumed`)
      })
      .catch((e: unknown) => toast(`${h.id} not resumed: ${why(e)}`))
      .finally(() => setSending(null))
  }
  const resumeBtn = (
    <Press className="va-resume vl-btn-line" data-lit={(notYet && anyUsable) || undefined} disabled={!!sending || !anyUsable} aria-busy={sending === 'resume' || undefined} onPress={resume}>
      {sending === 'resume' ? 'Resuming' : 'Resume'}
    </Press>
  )
  const noneText = h.nextReason === 'no pool token' || !anyUsable ? 'no account is set up yet' : h.nextReason ?? 'no other account has room'

  return (
    <section className="va-host vl-panel vl-build" style={iv(i)} data-host={h.id} aria-label={`${h.id} account`}>
      <header className="vc-u-head">
        <Icon name={hostIcon(h.id)} size={15} tone="fg" glow />
        <span className="vc-u-label">{h.id}</span>
        <span className="va-sub">every terminal</span>
      </header>
      <div className="va-now">
        <b className="vl-ellipsis" data-none={!h.accountId || undefined}>{h.accountId ? h.accountLabel ?? label(s, h.accountId) : own!.title}</b>
        {h.accountId ? (
          <em className="vl-ellipsis">{[h.since != null && `since ${etTime(h.since, now)}`, windows(cur)].filter(Boolean).join(' · ') || NBSP}</em>
        ) : (
          <p className="va-explain">{own!.text}</p>
        )}
      </div>
      {h.auto !== null && <HostAuto h={h} s={s} />}
      {notYet ? (
        <div className="va-take">
          {resumeBtn}
          <span>{anyUsable ? `Takes ${h.id} over with the account that has the most room.` : `Set up an account first: none has a token${h.id === 'thor' ? ' on thor' : ''} yet.`}</span>
        </div>
      ) : h.paused && (
        <div className="va-warn va-paused">
          <Icon name="alert" size={13} tone="acc2" glow />
          <span>Auto-switch paused here: {h.paused}</span>
          {resumeBtn}
        </div>
      )}
      {h.error && <div className="va-warn"><Icon name="alert" size={13} tone="acc2" />Last error: {h.error}</div>}
      <div className="va-next">
        <span className="va-next-label"><Icon name="enter" size={13} tone="dim" />Next</span>
        {h.next ? (
          <span className="va-next-what">
            <b className="vl-ellipsis">{h.next.label ?? label(s, h.next.accountId)}</b>
            {(windows(nextAcct) ?? h.nextReason) && <em className="vl-ellipsis">{windows(nextAcct) ?? h.nextReason}</em>}
          </span>
        ) : (
          <span className="va-next-what"><em>None: {noneText}</em></span>
        )}
      </div>

      {!open ? (
        <Press className="va-switch vl-btn-line" disabled={!choices.length} onPress={start} aria-label={`Switch ${h.id} now`}>
          <Icon name="refresh" size={14} tone="fg" />Switch now
        </Press>
      ) : (
        <div className="va-confirm vl-build-on">
          <span className="va-confirm-q">Switch every {h.id} terminal to{s.dryRun ? ' (real, even in dry run)' : ''}</span>
          <div className="va-picks" role="radiogroup" aria-label={`Account for ${h.id}`}>
            {choices.map((a) => (
              <Press
                key={a.id}
                className="va-pick"
                role="radio"
                aria-checked={a.id === pick}
                data-on={a.id === pick || undefined}
                onPress={() => setPick(a.id)}
              >
                <span className="vl-ellipsis">{a.label}</span>
                {windows(a) && <em>{windows(a)}</em>}
              </Press>
            ))}
          </div>
          <div className="va-confirm-act">
            <Press className="va-go vl-btn" disabled={!picked || !!sending} aria-busy={sending === 'switch' || undefined} onPress={confirm}>
              {sending === 'switch' ? 'Switching' : picked ? `Confirm: ${picked.label}` : 'Pick an account'}
            </Press>
            <Press className="va-cancel vl-link" disabled={sending === 'switch'} onPress={() => setOpen(false)}>Cancel</Press>
          </div>
        </div>
      )}
      {!choices.length && !open && anyUsable && <div className="va-quiet">No other account is set up for {h.id}.</div>}
    </section>
  )
}

/** One host's own auto-switch (config.hosts). */
function HostAuto({ h, s }: { h: HostVM; s: SwitchVM }) {
  const write = useWrite()
  const [sending, setSending] = useState(false)
  const on = h.auto === true
  const toggle = () => {
    if (sending) return
    setSending(true)
    write('/config', { hosts: { [h.id]: !on } })
      .then(() => toast(`Auto-switch ${on ? 'off' : 'on'} for ${h.id}`))
      .catch((e: unknown) => toast(`Auto-switch not changed for ${h.id}: ${why(e)}`))
      .finally(() => setSending(false))
  }
  return (
    <Press
      className="va-toggle va-host-auto vl-hit"
      role="switch"
      aria-checked={on}
      aria-busy={sending || undefined}
      aria-label={`Auto-switch on ${h.id} ${on ? 'on' : 'off'}`}
      data-on={on || undefined}
      disabled={sending}
      onPress={toggle}
    >
      <Icon name="power" size={14} tone={on ? 'fg' : 'dim'} glow={on && s.enabled && !s.killed} />
      <span className="va-toggle-label">Auto-switch here</span>
      <span className="va-toggle-state">{sending ? (on ? 'Turning off' : 'Turning on') : on ? (s.enabled ? 'On' : 'On (all off)') : 'Off'}</span>
      <i className="va-toggle-track" aria-hidden><i /></i>
    </Press>
  )
}

// ---------- accounts: each one's sign-in, Sign in / Renew, Copy to thor ----------

function AccountList({ s, si, now }: { s: SwitchVM; si: SigninsVM; now: number }) {
  const set = s.accounts.filter((a) => usable(a)).length
  const need = s.accounts.filter((a) => needsSignIn(a) && a.inPool).length
  const live = si.runs.find(runLive) ?? null
  const queueOn = si.queue?.state === 'running'
  return (
    <section className="va-signins vl-panel vl-build" style={iv(7)} aria-label="Switcher sign-ins">
      <header className="vc-u-head">
        <Icon name="claude" size={14} tone="dim" />
        <span className="vc-u-label">Switcher sign-ins</span>
        <span className="vc-u-count">{set} of {s.accounts.length} set up</span>
      </header>
      {need > 0 && (
        <p className="va-explain va-dim va-signins-note">
          Needs a sign-in: the switcher has no year-long token for this account yet, so it cannot switch to it.
        </p>
      )}
      {s.accounts.map((a) => {
        // the newest request for this account, while it runs or for a while after
        const r = si.runs.find((x) => x.accountId === a.id)
        const run = r && (runLive(r) || (r.at != null && now - r.at < RUN_SHOW_MS)) ? r : null
        // the setup panel carries the code box for its own sign-ins
        const inSetup = !!run?.queue && !!si.queue && (queueOn || si.queue.state === 'stopped')
        return <AccountRow key={a.id} a={a} s={s} run={run} inSetup={inSetup} busy={queueOn || (!!live && live.accountId !== a.id)} now={now} />
      })}
    </section>
  )
}

function AccountRow({ a, s, run, inSetup, busy, now }: { a: AcctVM; s: SwitchVM; run: RunVM | null; inSetup: boolean; busy: boolean; now: number }) {
  const write = useWrite()
  const [armed, setArmed] = useArm()
  const [sending, setSending] = useState<'signin' | 'copy' | null>(null)
  const where = HOSTS.filter((h) => s.hosts.find((x) => x.id === h)?.accountId === a.id)
  const good = usable(a)
  const need = needsSignIn(a)
  const running = runLive(run)

  const signIn = () => {
    if (sending || busy || running) return
    // a working token is replaced only on a second tap
    if (good && !armed) { setArmed(true); return }
    setArmed(false)
    setSending('signin')
    write('/signin', { accountId: a.id })
      .then(() => toast(`Sign-in link for ${a.label} is on its way in Lil kups`))
      .catch((e: unknown) => toast(`Sign-in not started for ${a.label}: ${why(e)}`))
      .finally(() => setSending(null))
  }
  const copy = () => {
    if (sending) return
    setSending('copy')
    write<{ ok?: boolean }>('/signin/sync-thor', { accountId: a.id })
      .then((r) => toast(r?.ok ? `${a.label} copied to thor` : `thor did not answer; ${a.label} is still on odin only`))
      .catch((e: unknown) => toast(`Not copied: ${why(e)}`))
      .finally(() => setSending(null))
  }
  const state = signInText(a, now) + (good && a.onThor === false ? ' · odin only' : '')
  const [toggling, setToggling] = useState(false)
  // Disable keeps the token but takes the account out of the rotation (config exclude); a host on
  // it moves to another account on the switcher's next check.
  const togglePool = () => {
    if (toggling) return
    setToggling(true)
    const others = s.accounts.filter((x) => !x.inPool && x.id !== a.id).map((x) => x.id)
    write('/config', { exclude: a.inPool ? [...others, a.id] : others })
      .then(() => toast(a.inPool
        ? `${a.label} disabled: the switcher will not use it${where.length ? `; ${where.join(' and ')} moves off it` : ''}`
        : `${a.label} enabled: back in the rotation`))
      .catch((e: unknown) => toast(`${a.label} not changed: ${why(e)}`))
      .finally(() => setToggling(false))
  }

  return (
    <div className="va-acct" data-acct={a.id} data-bad={(need && a.inPool) || undefined} data-out={!a.inPool || undefined}>
      <div className="va-acct-row">
        <span className="va-acct-name">
          <span className="vl-ellipsis">{a.label}{where.length ? <i className="va-on">{where.join(' + ')}</i> : null}</span>
          <em className="vl-ellipsis">{[a.email, !a.inPool && 'disabled: never switched to'].filter(Boolean).join(' · ')}</em>
        </span>
        <span className="va-acct-state" data-s={a.signIn}>
          {need && <Icon name="alert" size={13} tone="acc2" glow />}
          {good && <Icon name="done" size={12} tone="dim" />}
          <span className="vl-ellipsis">{state}</span>
        </span>
        <span className="va-acct-btns">
          {good && a.onThor === false && (
            <Press className="va-copy vl-link" data-lit disabled={!!sending} onPress={copy} aria-label={`Copy ${a.label} to thor`}>
              {sending === 'copy' ? 'Copying' : 'Copy to thor'}
            </Press>
          )}
          <Press
            className="va-pool vl-btn-line"
            data-off={!a.inPool || undefined}
            disabled={toggling}
            aria-pressed={!a.inPool}
            aria-label={a.inPool ? `Disable ${a.label}: the switcher stops using it` : `Enable ${a.label}: back in the rotation`}
            onPress={togglePool}
          >
            {toggling ? 'Saving' : a.inPool ? 'Disable' : 'Enable'}
          </Press>
          <Press
            className="va-resign vl-btn-line"
            data-armed={armed || undefined}
            disabled={!!sending || busy || running}
            aria-busy={sending === 'signin' || undefined}
            aria-label={armed ? `Confirm: renew ${a.label}` : good ? `Renew ${a.label}` : `Sign in ${a.label}`}
            onPress={signIn}
          >
            {sending === 'signin' ? 'Starting' : armed ? 'Renew?' : good ? 'Renew' : 'Sign in'}
          </Press>
        </span>
      </div>
      {a.identityWarning && <div className="va-warn"><Icon name="alert" size={13} tone="acc2" />{a.identityWarning}</div>}
      {a.why && good && !run && <div className="va-acct-msg">Not picked now: {a.why}</div>}
      {run && <RunLine a={a} run={run} compact={inSetup} now={now} />}
    </div>
  )
}

function runText(r: RunVM, now: number): string {
  switch (r.stage) {
    case 'starting': return 'Starting the sign-in'
    case 'browser': return 'Signing in on thor (headless browser and the mailbox)'
    case 'needs-code': return r.waitUntil ? `Waiting for your code until ${etTime(r.waitUntil, now)}` : 'Waiting for your code'
    case 'finishing': return r.detail === 'the code was refused; getting a new link' ? 'That code was refused: getting a new link' : 'Checking the code'
    case 'done': return r.vault ? (r.vault.thor === false ? 'Set up on odin; thor did not answer' : 'Set up: token saved on odin and thor') : 'Signed in'
    case 'failed': return `Failed: ${r.detail ?? 'no reason given'}`
    case 'canceled': return 'Canceled'
    case 'expired': return `Timed out: ${r.detail ?? 'no code was pasted in time'}`
  }
}

/** A sign-in in progress (or just ended) for this account: one line, and the code box when it needs a person. */
function RunLine({ a, run, compact, now }: { a: AcctVM; run: RunVM; compact: boolean; now: number }) {
  const write = useWrite()
  const [sending, setSending] = useState(false)
  const live = runLive(run)
  const bad = run.stage === 'failed' || run.stage === 'expired'
  const retry = () => {
    if (sending) return
    setSending(true)
    write('/signin', { accountId: a.id })
      .then(() => toast(`New sign-in link for ${a.label} is on its way`))
      .catch((e: unknown) => toast(`Sign-in not started for ${a.label}: ${why(e)}`))
      .finally(() => setSending(false))
  }
  const icon: IconName = bad ? 'alert' : run.stage === 'done' ? 'done' : run.stage === 'needs-code' ? 'asking' : run.stage === 'canceled' ? 'stop' : 'refresh'

  return (
    <div className="va-run" data-state={run.stage}>
      <div className="va-run-line">
        <Icon
          name={icon}
          size={13}
          tone={bad ? 'acc2' : 'fg'}
          glow={run.stage !== 'canceled'}
          className={live && run.stage !== 'needs-code' ? 'vl-pulse' : undefined}
        />
        <span>
          {runText(run, now)}
          {run.stage === 'done' && run.identity && run.identity !== 'organization not checked' && <em> · {run.identity}</em>}
          {!live && run.at != null && <em> · {etTime(run.at, now)}</em>}
        </span>
        {bad && !compact && (
          <Press className="va-run-retry vl-link" data-lit disabled={sending} onPress={retry}>{sending ? 'Starting' : 'Try again'}</Press>
        )}
      </div>
      {!compact && live && <RunBody run={run} email={a.email} label={a.label} now={now} />}
    </div>
  )
}

/** the sign-ins the DM link (?signin=<id>) already scrolled to on this page load */
const scrolledTo = new Set<string>()

/**
 * What a person does for a sign-in that waits on them: the steps, the box for the code (Paste reads
 * the clipboard and sends at once), the DM again, Cancel. Scrolls into view when the DM link
 * (?signin=<id>) opened the page.
 */
function RunBody({ run, email, label: who, now }: { run: RunVM; email: string | null; label: string; now: number }) {
  const write = useWrite()
  const [code, setCode] = useState('')
  const [sending, setSending] = useState<'code' | 'cancel' | 'dm' | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const waiting = run.stage === 'needs-code'
  const canPaste = typeof navigator !== 'undefined' && !!navigator.clipboard?.readText

  useEffect(() => {
    if (!waiting) return
    const target = (() => {
      try { return new URLSearchParams(window.location.search).get('signin') } catch { return null }
    })()
    if (target !== run.id || scrolledTo.has(run.id)) return
    // after the panels above have drawn, so the box does not slide away again
    const t = window.setTimeout(() => {
      scrolledTo.add(run.id)
      box.current?.scrollIntoView({ block: 'center' })
      input.current?.focus({ preventScroll: true })
    }, 600)
    return () => window.clearTimeout(t)
  }, [waiting, run.id])

  const looksRight = (c: string) => /#/.test(c) || /[?&]code=/.test(c)
  const send = (raw?: string) => {
    if (sending) return
    const c = (raw ?? code).trim()
    if (!looksRight(c)) { setHint('That is not the code: it has a # in the middle (or paste the whole page address).'); return }
    setHint(null)
    setSending('code')
    write(`/signin/${encodeURIComponent(run.id)}/code`, { code: c })
      .then(() => { setCode(''); toast(`Code sent for ${who}`) })
      .catch((e: unknown) => setHint(`Not taken: ${why(e)}`))
      .finally(() => setSending(null))
  }
  const paste = () => {
    if (sending || !canPaste) return
    navigator.clipboard.readText()
      .then((t) => {
        const c = t.trim()
        setCode(c)
        if (looksRight(c)) send(c)
        else setHint('The clipboard does not hold the code yet: copy it on the Claude page, then press Paste.')
      })
      .catch(() => { setHint('Valkyrie cannot read the clipboard here: paste into the box instead.'); input.current?.focus() })
  }
  const dmAgain = () => {
    if (sending) return
    setSending('dm')
    write(`/signin/${encodeURIComponent(run.id)}/dm`, {})
      .then(() => toast('Link sent again in Lil kups'))
      .catch((e: unknown) => toast(`DM not sent: ${why(e)}`))
      .finally(() => setSending(null))
  }
  const cancel = () => {
    if (sending) return
    setSending('cancel')
    write(`/signin/${encodeURIComponent(run.id)}/cancel`, {})
      .then(() => toast(`Sign-in canceled for ${who}`))
      .catch((e: unknown) => toast(`Sign-in not canceled for ${who}: ${why(e)}`))
      .finally(() => setSending(null))
  }
  const dmRecent = run.dmAt != null && now - run.dmAt < 60_000

  return (
    <div className="va-body" ref={box} data-signin={run.id}>
      {waiting && (
        <>
          <ol className="va-steps">
            <li>Open the link in the Lil kups DM in a private window{run.dmSent ? '' : ' (the DM failed: send it again)'}.</li>
            <li>Sign in as {email ?? who} and press Authorize.</li>
            <li>Copy the code the page shows and paste it here.</li>
          </ol>
          <form className="va-code" onSubmit={(e) => { e.preventDefault(); send() }}>
            <input
              ref={input}
              type="text"
              value={code}
              onChange={(e) => { setCode(e.target.value); setHint(null) }}
              placeholder="Paste the code"
              aria-label={`Sign-in code for ${who}`}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              enterKeyHint="send"
              disabled={!!sending}
            />
            {canPaste && !code.trim() ? (
              <Press className="va-code-send vl-btn" disabled={!!sending} aria-busy={sending === 'code' || undefined} onPress={paste}>
                <Icon name="copy" size={13} tone="fg" />{sending === 'code' ? 'Sending' : 'Paste'}
              </Press>
            ) : (
              <Press className="va-code-send vl-btn" disabled={!!sending || !code.trim()} aria-busy={sending === 'code' || undefined} onPress={() => send()}>
                {sending === 'code' ? 'Sending' : 'Send'}
              </Press>
            )}
          </form>
        </>
      )}
      {hint && <div className="va-warn"><Icon name="alert" size={13} tone="acc2" /><span>{hint}</span></div>}
      <div className="va-body-act">
        {waiting && (
          <Press className="vl-link" disabled={!!sending || dmRecent} onPress={dmAgain}>
            {sending === 'dm' ? 'Sending' : dmRecent ? 'DM sent' : 'Send the DM again'}
          </Press>
        )}
        <Press className="vl-link" disabled={!!sending} onPress={cancel} aria-label={`Cancel the sign-in for ${who}`}>
          {sending === 'cancel' ? 'Canceling' : 'Cancel'}
        </Press>
      </div>
    </div>
  )
}

// ---------- the last switches ----------

function History({ s, now }: { s: SwitchVM; now: number }) {
  const rows = s.history.slice(0, HISTORY_ROWS)
  return (
    <section className="va-hist vl-panel vl-build" style={iv(8)} aria-label="Last switches">
      <header className="vc-u-head">
        <Icon name="clock" size={14} tone="dim" />
        <span className="vc-u-label">Last switches</span>
        {s.history.length > HISTORY_ROWS && <span className="vc-u-count">{HISTORY_ROWS} of {s.history.length}</span>}
      </header>
      {rows.length ? rows.map((e, k) => (
        <div key={`${e.at}-${e.host}-${k}`} className="va-hist-row" data-failed={!e.ok || undefined} data-dry={e.kind === 'dry-run' || undefined} data-kind={e.kind}>
          <span className="va-hist-when">{etTime(e.at, now)}</span>
          <span className="va-hist-what">
            <span className="vl-ellipsis">
              <Icon name={hostIcon(e.host)} size={12} tone="dim" />
              <b>{e.host}</b>{' '}
              {e.kind === 'continue' ? 'continued' : e.to ? <>{label(s, e.from)} <i aria-label="to">→</i> {label(s, e.to)}</> : e.kind === 'paused' ? 'paused' : 'no switch'}
            </span>
            <em className="vl-ellipsis">
              {[
                e.kind === 'dry-run' && 'dry run',
                e.kind === 'manual' && 'by hand',
                !e.ok && `failed${e.error ? `: ${e.error}` : ''}`,
                e.reason,
                e.pcts,
                e.nudged > 0 && `${e.nudged} ${e.nudged === 1 ? 'pane' : 'panes'} continued`,
              ].filter(Boolean).join(' · ')}
            </em>
          </span>
        </div>
      )) : <div className="va-quiet">No switches yet.</div>}
    </section>
  )
}
