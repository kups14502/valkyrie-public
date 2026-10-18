import { useEffect, useState, type CSSProperties } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Press, toast } from '../kit/ui'
import { Icon, hostIcon } from '../kit/icons'
import { ago, useLive, type Live } from '../kit/data'
import { api, apiErrorText } from '../../lib/api'
import './accounts.css'

// AI > Usage, under the usage panels: the Claude account switcher's controls.
// Per host (thor, odin): the account every terminal on it uses now, since when,
// its own auto-switch, the account it would move to next, a pause with Resume,
// and Switch now (Switch now, pick, Confirm). Then auto-switch on/off, the
// threshold and the kill switch, every account's sign-in with Re-sign in (two
// taps; when the automation falls back to the one-tap path, a box for
// code#state), and the last switches with their times in ET.
//
// The switcher (backend routes/accountSwitch.ts, routes/accountSignin.ts):
//   GET  /api/account-switch                status: { enabled, dryRun, killed, config,
//        hosts: [{ host, enabled, active: { id, label } | null, owner, paused, pausedReason,
//                  lastSwitchAt, lastError, next: { id, label } | null, nextReason }],
//        accounts: [{ id, label, email, token: { present, dead, expiresAt },
//                     quota: { sessionPct, weeklyPct, sessionResetsAt, ... } | null, eligible, why }],
//        recent: [{ at, kind, host, from, to, reason, ok, fromPct, toPct, nudged, detail }] }
//   POST /api/account-switch/config         { enabled } | { thresholdPct } | { hosts: { <host>: bool } }
//   POST /api/account-switch/switch         { host, account, confirm: true } -> { results: [{ host, ok, error?, nudged }] }
//   POST /api/account-switch/resume         { host } -> { ok, switchedTo, error? } (409 when not ok)
//   POST /api/account-switch/kill           { on: false }
//   GET  /api/account-switch/signin         { requests: [{ id, accountId, stage, detail, fallbackReason,
//                                             needsCode, dmSent, startedAt, updatedAt, ok }] } newest first
//   POST /api/account-switch/signin         { accountId } -> 202 { request } (a one-year token for the vaults)
//   POST /api/account-switch/signin/:id/code    { code } (code#state)
//   POST /api/account-switch/signin/:id/cancel
// Times are ISO UTC. No route returns a token, a URL or a code; the code a
// person pastes goes up once and the box is cleared.

type Vars = CSSProperties & Record<`--${string}`, string | number>
const iv = (i: number): Vars => ({ '--i': i })

const KEY = 'accountSwitch'
const SKEY = 'accountSignin'
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
/** a finished sign-in stays on its row this long */
const RUN_SHOW_MS = 15 * 60_000
/** log kinds that are switches (or a switch that could not happen) */
const SWITCH_KINDS = new Set(['switch', 'manual', 'dry-run', 'error', 'exhausted', 'paused'])
const NBSP = String.fromCharCode(160)

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
  at: number | null
}

export type SwitchVM = {
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
export function toSwitchVM(data: unknown, now = Date.now()): SwitchVM {
  const d = obj(data)
  if (!d || (!Array.isArray(d.hosts) && !Array.isArray(d.accounts))) return NOT_INSTALLED
  const cfg = obj(d.config)
  const cfgHosts = obj(cfg?.hosts)
  const exclude = Array.isArray(cfg?.exclude) ? (cfg.exclude as unknown[]).filter((x): x is string => typeof x === 'string') : []
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
  const killed = d.killed === true
  return {
    installed: true,
    enabled: d.enabled === true,
    killed,
    dryRun: d.dryRun === true,
    threshold: t == null ? null : Math.round(t),
    hosts,
    accounts,
    history,
  }
}

/** GET /api/account-switch/signin: every request, newest first */
export function toRuns(data: unknown): RunVM[] {
  return list(obj(data)?.requests)
    .map((r): RunVM | null => {
      const id = str(r.id)
      const accountId = str(r.accountId)
      const stage = str(r.stage)
      if (!id || !accountId || !stage || !(STAGES as readonly string[]).includes(stage)) return null
      return {
        id,
        accountId,
        stage: stage as Stage,
        detail: str(r.detail),
        fallback: str(r.fallbackReason),
        dmSent: r.dmSent === true,
        at: when(r.updatedAt ?? r.startedAt),
      }
    })
    .filter((r): r is RunVM => !!r)
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

async function fetchRuns(): Promise<RunVM[]> {
  try {
    return toRuns((await api.get(`${BASE}/signin`)).data)
  } catch (e) {
    if (httpStatus(e) === 404) return []
    throw e
  }
}

function useSwitch(): Live<SwitchVM> {
  return useLive<SwitchVM>(KEY, fetchSwitch, 15_000, {
    revive: (c) => (obj(c) && Array.isArray((c as SwitchVM).hosts) && Array.isArray((c as SwitchVM).history) ? (c as SwitchVM) : undefined),
  })
}

function useRuns(): Live<RunVM[]> {
  const qc = useQueryClient()
  // a sign-in in progress is read every 3 s, so its steps and the code box show at once
  const prev = qc.getQueryData<RunVM[]>(SQKEY)
  return useLive<RunVM[]>(SKEY, fetchRuns, prev?.some(runLive) ? 3_000 : 30_000, {
    revive: (c) => (Array.isArray(c) ? (c as RunVM[]) : undefined),
  })
}

// ---------- writes ----------

/** "500 refused" from a failed write: the status, then the backend's own words */
const why = (e: unknown): string => {
  const status = httpStatus(e)
  const text = apiErrorText(e, (e as Error | null)?.message || 'no answer')
  const short = text.length > 90 ? `${text.slice(0, 89)}…` : text
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
export const etTime = (ms: number, now = Date.now()): string => {
  const t = timeFmt.format(ms)
  return dayKey.format(ms) === dayKey.format(now) ? `${t} ET` : `${dayFmt.format(ms)} ${t} ET`
}

const label = (s: SwitchVM, id: string | null): string => (id ? s.accounts.find((a) => a.id === id)?.label ?? id : 'none')
const usable = (a: AcctVM) => a.signIn === 'ok' || a.signIn === 'expiring'
const windows = (a: AcctVM | undefined): string | null => {
  if (!a || (a.five == null && a.week == null)) return null
  return [a.five != null && `5h ${a.five}%`, a.week != null && `week ${a.week}%`].filter(Boolean).join(' · ')
}

function signInText(a: AcctVM, now: number): string {
  const until = a.tokenExpiresAt && a.tokenExpiresAt > now ? dateFmt.format(a.tokenExpiresAt) : null
  switch (a.signIn) {
    case 'ok': return until ? `Signed in until ${until}` : 'Signed in'
    case 'expiring': return until ? `Expires ${until}` : 'Expires soon'
    case 'expired': return 'Sign-in expired'
    case 'missing': return 'Not signed in'
    case 'dead': return 'Sign-in refused (401)'
    default: return 'Sign-in unknown'
  }
}

const OWNER_TEXT: Record<string, string> = {
  grant: 'holds a /login sign-in, not one of the switcher\'s',
  unknown: 'holds a sign-in the switcher does not know',
  missing: 'has no sign-in file',
  unreachable: 'did not answer',
}

function runText(r: RunVM): string {
  switch (r.stage) {
    case 'starting': return 'Starting the sign-in'
    case 'browser': return 'Signing in on thor (headless browser and the mailbox)'
    case 'needs-code': return r.dmSent
      ? 'Needs you: open the sign-in link in the Lil kups DM, sign in, then paste the code here'
      : 'Needs you, but the Lil kups DM with the sign-in link failed'
    case 'finishing': return 'Finishing'
    case 'done': return 'Signed in'
    case 'failed': return 'Sign-in failed'
    case 'canceled': return 'Sign-in canceled'
    case 'expired': return 'Sign-in timed out'
  }
}

// ---------- the screen part ----------

/** The switcher's controls, shown inside AI > Usage. */
export function Accounts({ now }: { now: number }) {
  const q = useSwitch()
  const runs = useRuns()
  const s = q.data

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
      <AutoPanel s={s} q={q} now={now} />
      {s.hosts.map((h, k) => <HostCard key={h.id} h={h} s={s} now={now} i={4 + k} />)}
      <SignIns s={s} runs={runs.data ?? []} now={now} />
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

// ---------- auto-switch on/off, the threshold, the kill switch ----------

function AutoPanel({ s, q, now }: { s: SwitchVM; q: Live<SwitchVM>; now: number }) {
  const write = useWrite()
  const [sending, setSending] = useState<'auto' | 'threshold' | 'kill' | null>(null)
  const [draft, setDraft] = useState<number | null>(null)
  const [killArmed, setKillArmed] = useArm()
  const shown = draft ?? s.threshold ?? 98
  const changed = draft != null && draft !== s.threshold

  // the saved value caught up with the draft: drop the draft
  useEffect(() => {
    if (draft != null && draft === s.threshold && sending !== 'threshold') setDraft(null)
  }, [draft, s.threshold, sending])

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
      .then(() => toast(`Switches at ${v}% now`))
      .catch((e: unknown) => { toast(`Threshold not saved: ${why(e)}`); setDraft(null) })
      .finally(() => setSending(null))
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
    <section className="va-auto vl-panel vl-build" style={iv(3)} aria-label="Auto-switch" data-on={live || undefined}>
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
  const choices = s.accounts.filter((a) => usable(a) && a.id !== h.accountId)
  const nextAcct = h.next ? s.accounts.find((a) => a.id === h.next!.accountId) : undefined
  const [open, setOpen] = useState(false)
  const [pick, setPick] = useState<string | null>(null)
  const [sending, setSending] = useState<'switch' | 'resume' | null>(null)
  const picked = choices.find((a) => a.id === pick) ?? null
  const ownerNote = h.owner ? OWNER_TEXT[h.owner] ?? null : null

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
        toast(r?.switchedTo ? `${h.id} resumed on ${label(s, r.switchedTo)}` : `${h.id} resumed`)
      })
      .catch((e: unknown) => toast(`${h.id} not resumed: ${why(e)}`))
      .finally(() => setSending(null))
  }

  return (
    <section className="va-host vl-panel vl-build" style={iv(i)} data-host={h.id} aria-label={`${h.id} account`}>
      <header className="vc-u-head">
        <Icon name={hostIcon(h.id)} size={15} tone="fg" glow />
        <span className="vc-u-label">{h.id}</span>
        <span className="va-sub">every terminal</span>
      </header>
      <div className="va-now">
        <b className="vl-ellipsis" data-none={!h.accountId || undefined}>{h.accountId ? h.accountLabel ?? label(s, h.accountId) : 'Not on a switcher account'}</b>
        <em className="vl-ellipsis">
          {[h.since != null && `since ${etTime(h.since, now)}`, windows(cur), !h.accountId && ownerNote && `${h.id} ${ownerNote}`].filter(Boolean).join(' · ') || NBSP}
        </em>
      </div>
      {h.auto !== null && <HostAuto h={h} s={s} />}
      {h.paused && (
        <div className="va-warn va-paused">
          <Icon name="alert" size={13} tone="acc2" glow />
          <span>Auto-switch paused here: {h.paused}</span>
          <Press className="va-resume vl-btn-line" disabled={!!sending} aria-busy={sending === 'resume' || undefined} onPress={resume}>
            {sending === 'resume' ? 'Resuming' : 'Resume'}
          </Press>
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
          <span className="va-next-what"><em>None: {h.nextReason ?? 'no other account has room'}</em></span>
        )}
      </div>

      {!open ? (
        <Press className="va-switch vl-btn-line" disabled={!choices.length} onPress={start} aria-label={`Switch ${h.id} now`}>
          <Icon name="refresh" size={14} tone="fg" />Switch now
        </Press>
      ) : (
        <div className="va-confirm vl-build-on" data-no-swipe>
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
      {!choices.length && !open && <div className="va-quiet">No other account has a working sign-in.</div>}
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

// ---------- sign-ins: every account, Re-sign in, the code box ----------

function SignIns({ s, runs, now }: { s: SwitchVM; runs: RunVM[]; now: number }) {
  const bad = s.accounts.filter((a) => !usable(a) && a.inPool).length
  const active = runs.find(runLive) ?? null
  return (
    <section className="va-signins vl-panel vl-build" style={iv(6)} aria-label="Sign-ins">
      <header className="vc-u-head">
        <Icon name="claude" size={14} tone="dim" />
        <span className="vc-u-label">Sign-ins</span>
        <span className="vc-u-count">{s.accounts.length - bad} working{bad ? <em> · {bad} need a sign-in</em> : null}</span>
      </header>
      {s.accounts.map((a) => {
        // the newest request for this account, while it runs or for a while after
        const r = runs.find((x) => x.accountId === a.id)
        const run = r && (runLive(r) || (r.at != null && now - r.at < RUN_SHOW_MS)) ? r : null
        return <SignInRow key={a.id} a={a} s={s} run={run} busy={!!active && active.accountId !== a.id} now={now} />
      })}
    </section>
  )
}

function SignInRow({ a, s, run, busy, now }: { a: AcctVM; s: SwitchVM; run: RunVM | null; busy: boolean; now: number }) {
  const write = useWrite()
  const [armed, setArmed] = useArm()
  const [sending, setSending] = useState(false)
  const where = HOSTS.filter((h) => s.hosts.find((x) => x.id === h)?.accountId === a.id)
  const good = usable(a)
  const running = runLive(run)

  const press = () => {
    if (sending || busy || running) return
    if (!armed) { setArmed(true); return }
    setArmed(false)
    setSending(true)
    write('/signin', { accountId: a.id })
      .then(() => toast(`Signing in ${a.label}`))
      .catch((e: unknown) => toast(`Sign-in not started for ${a.label}: ${why(e)}`))
      .finally(() => setSending(false))
  }

  return (
    <div className="va-acct" data-acct={a.id} data-bad={(!good && a.inPool) || undefined} data-out={!a.inPool || undefined}>
      <div className="va-acct-row">
        <span className="va-acct-name">
          <span className="vl-ellipsis">{a.label}{where.length ? <i className="va-on">{where.join(' + ')}</i> : null}</span>
          <em className="vl-ellipsis">{[a.email, !a.inPool && 'not in the rotation'].filter(Boolean).join(' · ')}</em>
        </span>
        <span className="va-acct-state" data-s={a.signIn}>
          {!good && a.signIn !== 'unknown' && <Icon name="alert" size={13} tone="acc2" glow />}
          <span className="vl-ellipsis">{signInText(a, now)}</span>
        </span>
        <Press
          className="va-resign vl-btn-line"
          data-armed={armed || undefined}
          data-lit={(!good && a.inPool) || armed || undefined}
          disabled={sending || busy || running}
          aria-busy={sending || undefined}
          aria-label={armed ? `Confirm: sign in ${a.label} again` : `Re-sign in ${a.label}`}
          onPress={press}
        >
          {sending ? 'Starting' : armed ? 'Start?' : 'Re-sign in'}
        </Press>
      </div>
      {a.why && good && !run && <div className="va-acct-msg">Not picked now: {a.why}</div>}
      {run && <RunLine a={a} run={run} now={now} />}
    </div>
  )
}

/** A sign-in in progress (or just ended) for this account, and the code box when it needs a person. */
function RunLine({ a, run, now }: { a: AcctVM; run: RunVM; now: number }) {
  const write = useWrite()
  const [code, setCode] = useState('')
  const [sending, setSending] = useState<'code' | 'cancel' | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const live = runLive(run)
  const bad = run.stage === 'failed' || run.stage === 'expired' || run.stage === 'needs-code'

  const send = () => {
    if (sending) return
    const c = code.trim()
    if (!c.includes('#')) { setHint('Paste the whole code: it has a # in the middle.'); return }
    setHint(null)
    setSending('code')
    write(`/signin/${encodeURIComponent(run.id)}/code`, { code: c })
      .then(() => { setCode(''); toast(`Code sent for ${a.label}`) })
      .catch((e: unknown) => toast(`Code not taken for ${a.label}: ${why(e)}`))
      .finally(() => setSending(null))
  }
  const cancel = () => {
    if (sending) return
    setSending('cancel')
    write(`/signin/${encodeURIComponent(run.id)}/cancel`, {})
      .then(() => toast(`Sign-in canceled for ${a.label}`))
      .catch((e: unknown) => toast(`Sign-in not canceled for ${a.label}: ${why(e)}`))
      .finally(() => setSending(null))
  }
  const extra = run.stage === 'needs-code' ? run.fallback : run.detail

  return (
    <div className="va-run" data-state={run.stage}>
      <div className="va-run-line">
        <Icon
          name={bad && run.stage !== 'needs-code' ? 'alert' : run.stage === 'done' ? 'done' : run.stage === 'needs-code' ? 'asking' : run.stage === 'canceled' ? 'stop' : 'refresh'}
          size={13}
          tone={bad ? 'acc2' : 'fg'}
          glow={run.stage !== 'done' && run.stage !== 'canceled'}
          className={live && run.stage !== 'needs-code' ? 'vl-pulse' : undefined}
        />
        <span>
          {runText(run)}
          {extra ? `: ${extra}` : ''}
          {run.at != null && <em> · {etTime(run.at, now)}</em>}
        </span>
        {live && (
          <Press className="va-run-cancel vl-link" disabled={!!sending} onPress={cancel} aria-label={`Cancel the sign-in for ${a.label}`}>
            {sending === 'cancel' ? 'Canceling' : 'Cancel'}
          </Press>
        )}
      </div>
      {run.stage === 'needs-code' && (
        <form className="va-code" data-no-swipe onSubmit={(e) => { e.preventDefault(); send() }}>
          <input
            type="text"
            value={code}
            onChange={(e) => { setCode(e.target.value); setHint(null) }}
            placeholder="code#state"
            aria-label={`Sign-in code for ${a.label}`}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="send"
            disabled={!!sending}
          />
          <Press className="va-code-send vl-btn" disabled={!!sending || !code.trim()} aria-busy={sending === 'code' || undefined} onPress={send}>
            {sending === 'code' ? 'Sending' : 'Send'}
          </Press>
        </form>
      )}
      {hint && <div className="va-warn">{hint}</div>}
    </div>
  )
}

// ---------- the last switches ----------

function History({ s, now }: { s: SwitchVM; now: number }) {
  const rows = s.history.slice(0, HISTORY_ROWS)
  return (
    <section className="va-hist vl-panel vl-build" style={iv(7)} aria-label="Last switches">
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
              {e.to ? <>{label(s, e.from)} <i aria-label="to">→</i> {label(s, e.to)}</> : e.kind === 'paused' ? 'paused' : 'no switch'}
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
