import { Router, type Response } from 'express'
import {
  continueCheck, getStatus, pauseHostByHand, readConfig, readLog, reportContinued, reportLimit, resumeHost, setKill, switchNow, updateConfig,
} from '../lib/accountSwitch.js'
import { ACCOUNT_ID_RE, HOSTS, type HostName } from '../lib/accountSwitchCore.js'

// The Claude account switcher's API (lib/accountSwitch.ts). Behind requireAuth
// like every /api route; thor's StopFailure hook reaches limit-event over the
// tailnet, which requireAuth trusts by socket address.
//
//   GET  /api/account-switch[?refresh=1]   status (shape below); refresh=1 asks
//                                          both hosts which sign-in they hold
//   GET  /api/account-switch/log[?limit=N] { entries: LogEntry[] }, newest first
//   POST /api/account-switch/config        { enabled?, dryRun?, thresholdPct?,
//                                          targetMaxPct?, weeklyMaxPct?, minIntervalMin?,
//                                          maxPerDay?, nudge?, hosts?: { thor?, odin? } }
//                                          -> { config }
//   POST /api/account-switch/switch        { host: 'thor'|'odin'|'all', account, confirm: true }
//                                          -> { results: [{ host, ok, error?, nudged }] }
//   POST /api/account-switch/resume        { host } -> { ok, switchedTo, error? }
//   POST /api/account-switch/pause         { host } -> { ok }
//   POST /api/account-switch/kill          { on: boolean } -> { killed }
//   POST /api/account-switch/limit-event[?host=thor|odin]
//                                          the StopFailure hook payload (host may also
//                                          be in the body) -> { accepted, limit, why }
//   GET  /api/account-switch/continue-check?host=thor|odin
//                                          thor's continue runner: may a session stopped
//                                          on a limit be continued now -> { ok, why, active, text }
//   POST /api/account-switch/continued?host=thor|odin  { count: 1-50 }
//                                          the runner continued that many sessions -> { ok }
//
// Status:
//   { enabled, dryRun, killed, config: SwitchConfig,
//     vault: { dir, exists, modeOk, entries, badFiles },
//     hosts: [{ host, enabled, active: { id, label } | null,
//               owner: 'pool'|'grant'|'unknown'|'missing'|'unreachable'|null,
//               adopted, paused, pausedReason, lastSwitchAt, lastDryRunAt (ISO),
//               switches24h, checkedAt, lastError, next: { id, label } | null, nextReason }],
//     accounts: [{ id, label, email, token: { present, dead, expiresAt },
//                  quota: { sessionPct, weeklyPct, sessionResetsAt, weeklyResetsAt, status } | null,
//                  quotaAt, quotaSource: 'probe'|'usage'|null, eligible, why, activeOn: host[] }],
//     recent: LogEntry[] }
//   LogEntry: { at, kind: 'switch'|'manual'|'adopt'|'dry-run'|'blocked'|'exhausted'|'paused'|'error'|'config'|'continue',
//               host, from, to, reason, ok, fromPct?, toPct?, nudged?, detail? }
// Times are ISO UTC; the page shows them in New York time.

const router = Router()

const fail = (res: Response, err: unknown) => {
  const e = err as Error & { status?: number }
  const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 500
  if (status === 500) console.error('[account-switch] route failed', e.message)
  res.status(status).json({ error: e.message || 'failed' })
}

const asHost = (v: unknown): HostName | null => (typeof v === 'string' && (HOSTS as string[]).includes(v) ? v as HostName : null)

router.get('/account-switch', async (req, res) => {
  try {
    res.json(await getStatus({ refresh: req.query.refresh === '1' }))
  } catch (err) {
    fail(res, err)
  }
})

router.get('/account-switch/log', (req, res) => {
  const limit = Number(req.query.limit ?? 50)
  res.json({ entries: readLog(Number.isFinite(limit) ? limit : 50) })
})

const CONFIG_KEYS = new Set([
  'enabled', 'dryRun', 'hosts', 'thresholdPct', 'targetMaxPct', 'weeklyMaxPct', 'minIntervalMin',
  'hardFloorSec', 'maxPerDay', 'nudge', 'nudgeText', 'order', 'lastResort', 'exclude',
])

router.post('/account-switch/config', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const patch: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(body)) if (CONFIG_KEYS.has(k)) patch[k] = v
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing to change', config: readConfig() })
  try {
    res.json({ config: updateConfig(patch) })
  } catch (err) {
    fail(res, err)
  }
})

router.post('/account-switch/switch', async (req, res) => {
  const b = (req.body ?? {}) as { host?: unknown; account?: unknown; confirm?: unknown }
  const host = b.host === 'all' ? 'all' : asHost(b.host)
  if (!host) return res.status(400).json({ error: 'host must be thor, odin or all' })
  if (typeof b.account !== 'string' || !ACCOUNT_ID_RE.test(b.account)) return res.status(400).json({ error: 'account must be an account id' })
  if (b.confirm !== true) return res.status(400).json({ error: 'a switch needs confirm: true' })
  try {
    res.json(await switchNow(host, b.account))
  } catch (err) {
    fail(res, err)
  }
})

router.post('/account-switch/resume', async (req, res) => {
  const host = asHost((req.body ?? {}).host)
  if (!host) return res.status(400).json({ error: 'host must be thor or odin' })
  try {
    const r = await resumeHost(host)
    res.status(r.ok ? 200 : 409).json(r)
  } catch (err) {
    fail(res, err)
  }
})

router.post('/account-switch/pause', async (req, res) => {
  const host = asHost((req.body ?? {}).host)
  if (!host) return res.status(400).json({ error: 'host must be thor or odin' })
  try {
    await pauseHostByHand(host)
    res.json({ ok: true })
  } catch (err) {
    fail(res, err)
  }
})

router.post('/account-switch/kill', (req, res) => {
  const on = (req.body ?? {}).on
  if (typeof on !== 'boolean') return res.status(400).json({ error: 'on must be true or false' })
  try {
    setKill(on)
    res.json({ killed: on })
  } catch (err) {
    fail(res, err)
  }
})

// The hook sends what Claude Code gave it: error, last_assistant_message,
// session_id. Nothing else in the payload is read or kept.
router.post('/account-switch/limit-event', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>
  const host = asHost(req.query.host) ?? asHost(b.host)
  if (!host) return res.status(400).json({ error: 'host must be thor or odin' })
  const message = typeof b.last_assistant_message === 'string' ? b.last_assistant_message.slice(0, 500) : ''
  const sessionId = typeof b.session_id === 'string' ? b.session_id : undefined
  const error = typeof b.error === 'string' ? b.error : undefined
  res.json(reportLimit(host, { message, sessionId, error }))
})

router.get('/account-switch/continue-check', (req, res) => {
  const host = asHost(req.query.host)
  if (!host) return res.status(400).json({ error: 'host must be thor or odin' })
  try {
    res.json(continueCheck(host))
  } catch (err) {
    fail(res, err)
  }
})

router.post('/account-switch/continued', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>
  const host = asHost(req.query.host) ?? asHost(b.host)
  if (!host) return res.status(400).json({ error: 'host must be thor or odin' })
  const count = b.count
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 50) return res.status(400).json({ error: 'count must be a whole number from 1 to 50' })
  try {
    reportContinued(host, count)
    res.json({ ok: true })
  } catch (err) {
    fail(res, err)
  }
})

export default router
