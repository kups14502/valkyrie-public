/**
 * The continue path for sessions outside Valkyrie (thor's Windows Terminal tabs): lib/accountSwitch.ts
 * continueCheck and reportContinued, and their routes (GET /api/account-switch/continue-check, POST
 * /api/account-switch/continued), which thor's Continue-Stopped.ps1 calls before and after it types
 * a continue. A scratch switcher dir with a state.json the way a tick leaves it; no network, no tmux,
 * never thor. Run on odin from a scratch copy:
 *
 *   node --import tsx scripts/accountContinueSmoke.mts
 *
 * The screens the runner judges are covered by scripts/fixtures/pane-screens.json (accountSwitchSmoke.mts
 * here, Test-ContinueStopped.ps1 on thor).
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const T = mkdtempSync(path.join(tmpdir(), 'vk-continue-'))
Object.assign(process.env, {
  CLAUDE_SWITCH_DIR: `${T}/sw`,
  CLAUDE_SWITCH_VAULT: `${T}/sw/tokens`,
  CLAUDE_SWITCH_ODIN_LIVE: `${T}/store`,
  CLAUDE_ACCOUNTS_FILE: `${T}/accounts.json`,
  CLAUDE_SWITCH_API_BASE: 'http://127.0.0.1:1',
  LILKUPS_BIN: `${T}/no-lilkups`,
  VALKYRIE_TMUX_SOCKET: 'vk-continue-smoke-none',
  PORT: '1',
  THOR_SSH_HOST: '127.0.0.9',
})
mkdirSync(`${T}/sw/tokens`, { recursive: true, mode: 0o700 })
const TOK = { 'seat-a': 'dummy-seat-a-token-0000000000000000', 'seat-b': 'dummy-seat-b-token-0000000000000000' }
for (const [id, tok] of Object.entries(TOK)) {
  writeFileSync(`${T}/sw/tokens/${id}.json`, JSON.stringify({ accountId: id, accessToken: tok, expiresAt: Date.now() + 300 * 86_400_000, scopes: ['user:inference'] }), { mode: 0o600 })
}
writeFileSync(`${T}/accounts.json`, JSON.stringify(Object.keys(TOK).map((id) => ({ id, label: `Seat ${id.slice(-1).toUpperCase()}`, email: `${id}@example.invalid`, configDir: `${T}/none-${id}` }))))

const sw = await import('../src/lib/accountSwitch.ts')
const { DEFAULT_NUDGE } = await import('../src/lib/accountSwitchCore.ts')

const MIN = 60_000
const quota = (sessionPct: number, weeklyPct = 30, status = 'allowed') => ({
  sessionPct, weeklyPct, sessionResetsAt: new Date(Date.now() + 4 * 60 * MIN).toISOString(), weeklyResetsAt: new Date(Date.now() + 3 * 1440 * MIN).toISOString(), status,
})
type Over = { thor?: Record<string, unknown>; probeA?: { at?: number; quota?: ReturnType<typeof quota> } }
function state(o: Over = {}): void {
  const now = Date.now()
  const thor = {
    active: 'seat-a', owner: 'pool', adopted: true, paused: false, pausedReason: null, lastSwitchAt: now - 10 * MIN, lastDryRunAt: null,
    switches: [now - 10 * MIN], checkedAt: now - 30_000, lastError: null, lastBlocked: null, vaultIds: ['seat-a', 'seat-b'], failed: {}, ...o.thor,
  }
  const odin = { active: null, owner: 'missing', adopted: false, paused: true, pausedReason: 'not adopted yet', lastSwitchAt: null, lastDryRunAt: null, switches: [], checkedAt: now - 30_000, lastError: null, lastBlocked: null, vaultIds: null, failed: {} }
  writeFileSync(`${T}/sw/state.json`, JSON.stringify({
    version: 1,
    hosts: { thor, odin },
    probes: {
      'seat-a': { at: o.probeA?.at ?? now - 20_000, httpStatus: 200, quota: o.probeA?.quota ?? quota(3) },
      'seat-b': { at: now - 20_000, httpStatus: 200, quota: quota(10) },
    },
    dead: {}, notified: {},
  }), { mode: 0o600 })
}
const config = (o: Record<string, unknown> = {}) => writeFileSync(`${T}/sw/config.json`, JSON.stringify({ enabled: true, dryRun: false, hosts: { thor: true, odin: false }, nudge: true, ...o }), { mode: 0o600 })

let passed = 0
const failures: string[] = []
const test = async (name: string, fn: () => void | Promise<void>) => {
  try {
    await fn()
    passed++
  } catch (err) {
    failures.push(`${name}: ${(err as Error).message.split('\n').slice(0, 6).join(' | ')}`)
  }
}
const check = (o: { cfg?: Record<string, unknown>; st?: Over } = {}) => {
  config(o.cfg)
  state(o.st)
  return sw.continueCheck('thor')
}

try {
  await test('check: thor on a pool account with room may be continued, with the configured text', () => {
    assert.deepEqual(check(), { ok: true, why: 'active account has room', active: 'seat-a', text: DEFAULT_NUDGE })
    config({ nudgeText: 'Carry on with the task.' })
    assert.equal(sw.continueCheck('thor').text, 'Carry on with the task.')
  })
  await test('check: the active account still near or at its limit is not continued', () => {
    assert.equal(check({ st: { probeA: { quota: quota(99) } } }).ok, false)
    const hard = check({ st: { probeA: { quota: quota(100, 30, 'rejected') } } })
    assert.equal(hard.ok, false)
    assert.match(hard.why, /limit reached/)
    assert.equal(check({ st: { probeA: { quota: quota(20, 99) } } }).ok, false)
  })
  await test('check: no fresh reading of the active account is no continue', () => {
    const r = check({ st: { probeA: { at: Date.now() - 10 * MIN } } })
    assert.deepEqual([r.ok, r.why], [false, 'no fresh reading for the active account'])
  })
  await test('check: off, dry run, continue off, thor off, the kill switch', () => {
    assert.deepEqual([check({ cfg: { enabled: false } }).ok, check({ cfg: { enabled: false } }).why], [false, 'auto-switch is off'])
    assert.equal(check({ cfg: { dryRun: true } }).why, 'dry run')
    assert.equal(check({ cfg: { nudge: false } }).why, 'continue is off in config')
    assert.equal(check({ cfg: { hosts: { thor: false } } }).why, 'thor is off')
    writeFileSync(`${T}/sw/disabled`, 'x\n')
    try {
      assert.deepEqual([check().ok, check().why], [false, 'kill switch is on'])
    } finally {
      rmSync(`${T}/sw/disabled`)
    }
    assert.equal(check().ok, true)
  })
  await test('check: a paused host, a /login sign-in, a host never taken over', () => {
    assert.equal(check({ st: { thor: { paused: true, pausedReason: 'the live sign-in came from /login' } } }).why, 'paused: the live sign-in came from /login')
    assert.deepEqual([check({ st: { thor: { owner: 'grant', active: null } } }).ok, check({ st: { thor: { owner: 'grant', active: null } } }).why], [false, 'the switcher does not hold this host'])
    assert.equal(check({ st: { thor: { adopted: false } } }).ok, false)
    assert.equal(check({ st: { thor: { owner: 'unreachable' } } }).ok, false)
  })
  await test('report: one continue line in the log, for the history', () => {
    config()
    state()
    sw.reportContinued('thor', 3)
    const e = sw.readLog(1)[0]
    assert.equal(e.kind, 'continue')
    assert.equal(e.host, 'thor')
    assert.equal(e.to, 'seat-a')
    assert.equal(e.nudged, 3)
    assert.equal(e.reason, 'continued 3 terminals outside Valkyrie stopped on a limit')
    sw.reportContinued('thor', 1)
    assert.equal(sw.readLog(1)[0].reason, 'continued 1 terminal outside Valkyrie stopped on a limit')
  })

  // ---------------------------------------------------------------- routes --
  const express = (await import('express')).default
  const { default: route } = await import('../src/routes/accountSwitch.ts')
  const app = express()
  app.use(express.json())
  app.use('/api', route)
  const srv = app.listen(0, '127.0.0.1')
  await new Promise((r) => srv.once('listening', r))
  const port = (srv.address() as { port: number }).port
  const http = async (m: string, p: string, b?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}/api${p}`, { method: m, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) })
    return [r.status, await r.json()] as const
  }
  try {
    config()
    state()
    await test('route: GET continue-check for thor', async () => {
      const [s, b] = await http('GET', '/account-switch/continue-check?host=thor')
      assert.equal(s, 200)
      assert.deepEqual(b, { ok: true, why: 'active account has room', active: 'seat-a', text: DEFAULT_NUDGE })
      assert.doesNotMatch(JSON.stringify(b), /dummy-seat/)
    })
    await test('route: continue-check needs a known host', async () => {
      assert.equal((await http('GET', '/account-switch/continue-check'))[0], 400)
      assert.equal((await http('GET', '/account-switch/continue-check?host=mimir'))[0], 400)
    })
    await test('route: continued takes a whole count from 1 to 50', async () => {
      const before = sw.readLog(500).length
      assert.deepEqual(await http('POST', '/account-switch/continued?host=thor', { count: 2 }), [200, { ok: true }])
      for (const bad of [0, 51, 2.5, '2', null]) assert.equal((await http('POST', '/account-switch/continued?host=thor', { count: bad }))[0], 400, `count ${String(bad)}`)
      assert.equal((await http('POST', '/account-switch/continued', { count: 2 }))[0], 400)
      assert.equal((await http('POST', '/account-switch/continued', { host: 'thor', count: 1 }))[0], 200)
      assert.equal(sw.readLog(500).length, before + 2)
    })
  } finally {
    srv.close()
  }
} finally {
  rmSync(T, { recursive: true, force: true })
}

console.log(`${passed} passed, ${failures.length} failed`)
for (const f of failures) console.log('FAIL', f)
process.exit(failures.length ? 1 : 0)
