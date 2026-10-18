/**
 * Account switcher end to end, against a throwaway rig: a loopback fake API
 * (dummy tokens only, no real usage), a real Claude Code TUI in a scratch
 * config on its own tmux socket (ccsw-svc), a scratch vault, a scratch live
 * store, and a Lil kups stub. Never touches the valkyrie socket, ~/.claude,
 * ~/.config/claude-switch or thor. Run on odin from a scratch copy:
 *
 *   scripts/account-switch-rig/rig.sh up
 *   node --import tsx scripts/accountSwitchE2E.mts
 *   scripts/account-switch-rig/rig.sh down
 *
 * The rig's tokens: fake-a 429 (session full), fake-b 2%, fake-c 95%, fake-d 401.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const T = process.env.T || '/tmp/ccsw-svc'
const RIG = path.join(path.dirname(fileURLToPath(import.meta.url)), 'account-switch-rig', 'rig.sh')
Object.assign(process.env, {
  CLAUDE_SWITCH_DIR: `${T}/sw`,
  CLAUDE_SWITCH_VAULT: `${T}/sw/tokens`,
  CLAUDE_SWITCH_ODIN_LIVE: `${T}/store`,
  CLAUDE_SWITCH_API_BASE: `http://127.0.0.1:${process.env.PORT_FAKE || 18791}`,
  CLAUDE_ACCOUNTS_FILE: `${T}/accounts.json`,
  VALKYRIE_TMUX_SOCKET: 'ccsw-svc',
  VALKYRIE_TMUX_CONF: `${T}/no-such-tmux.conf`,
  LILKUPS_BIN: `${T}/lilkups-stub`,
  // Nothing listens on port 1, so the backend usage read fails and the
  // switcher runs on its own probes alone.
  PORT: '1',
  // tmux 3.7 prints the \x1f field separator listSessions splits on as '_'
  // to a client without a UTF-8 locale. valkyrie-api has LANG set; a bare
  // ssh shell does not.
  LANG: 'en_US.UTF-8',
  // The status refresh asks thor too; point it at an address nothing answers
  // on so the test never reaches the real thor.
  THOR_SSH_HOST: '127.0.0.9',
})

const sw = await import('../src/lib/accountSwitch.ts')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const rig = (...a: string[]) => execFileSync(RIG, a, { env: { ...process.env, T }, encoding: 'utf8' })
const cap = () => rig('cap')
const store = () => JSON.parse(readFileSync(`${T}/store/.credentials.json`, 'utf8'))
const storeTok = () => String(store().claudeAiOauth.accessToken).slice(0, 7)
const dms = () => (existsSync(`${T}/dm.log`) ? readFileSync(`${T}/dm.log`, 'utf8') : '')
const apiLog = () => readFileSync(`${T}/api.log`, 'utf8')
const log = () => sw.readLog(100)
const config = (o: Record<string, unknown>) => writeFileSync(`${T}/sw/config.json`, JSON.stringify(o), { mode: 0o600 })
const waitFor = async (what: string, fn: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return
    await sleep(500)
  }
  throw new Error(`timed out waiting for ${what}`)
}
const step = (s: string) => console.log(`\n== ${s}`)
const base = { enabled: true, hosts: { thor: false, odin: true }, hardFloorSec: 15, minIntervalMin: 1 }

let ok = 0
const check = (name: string, fn: () => void) => {
  fn()
  ok++
  console.log(`  pass  ${name}`)
}

step('the pane hits the session limit on fake-a')
await waitFor('the rig prompt', () => /❯/.test(cap()))
rig('type', 'say hi')
await waitFor('the limit screen', () => /Usage limit reached · continuing automatically/.test(cap()))
check('store starts on fake-a', () => assert.equal(storeTok(), 'dummy-A'))

step('disabled: a tick does nothing')
config({ ...base, enabled: false })
await sw.__test.tick(false)
check('no log while disabled', () => assert.equal(log().length, 0))

step('adopt odin (already on a pool token)')
config({ ...base, dryRun: true })
const res = await sw.resumeHost('odin')
check('resume adopts without a write', () => assert.deepEqual(res, { ok: true, switchedTo: null }))

step('dry run: decides, writes nothing, DMs once')
await sw.__test.tick(false)
const dry = log().find((e) => e.kind === 'dry-run')
check('dry-run entry fake-a -> fake-b', () => assert.equal(`${dry?.from}->${dry?.to}`, 'fake-a->fake-b'))
check('store untouched in dry run', () => assert.equal(storeTok(), 'dummy-A'))
check('dry-run DM sent', () => assert.match(dms(), /Dry run: would switch odin from Fake A \(session 100%.*to Fake B \(session 2%/))
await sw.__test.tick(false)
check('dry-run DM not repeated', () => assert.equal(dms().split('\n').filter((l) => l.includes('Dry run')).length, 1))

step('live: switch, nudge the stopped pane, DM')
config({ ...base, dryRun: false })
await sw.__test.tick(false)
const sw1 = log().find((e) => e.kind === 'switch')
check('switch entry fake-a -> fake-b, 1 pane continued', () => {
  assert.equal(`${sw1?.from}->${sw1?.to}`, 'fake-a->fake-b')
  assert.equal(sw1?.nudged, 1)
})
check('store now on fake-b, mcpOAuth kept, mode 600', () => {
  assert.equal(storeTok(), 'dummy-B')
  assert.deepEqual(store().mcpOAuth, { 'keep-me': { x: 1 } })
  assert.equal(store().claudeAiOauth.refreshToken, null)
  assert.equal(statSync(`${T}/store/.credentials.json`).mode & 0o777, 0o600)
})
await waitFor('the reply on fake-b', () => /REPLY-FROM-ACCOUNT-B/.test(cap()))
check('the pane ran its turn on fake-b', () => assert.match(apiLog(), /stream=True[\s\S]*tok=dummy-B-t model=claude-haiku-4-5-20251001 stream=True/))
check('switch DM names both accounts and the nudge', () => assert.match(dms(), /Switched odin from Fake A .* to Fake B .*Continued 1 stopped pane\./))
check('fake-d was probed, refused, and DMed once', () => {
  const st = JSON.parse(readFileSync(`${T}/sw/state.json`, 'utf8'))
  assert.ok(st.dead['fake-d'] || !st.probes['fake-d'], 'fake-d not yet probed is fine')
})

step('no switch while the active account has room')
const before = log().length
await sw.__test.tick(false)
check('fake-b at 2% stays', () => {
  assert.equal(storeTok(), 'dummy-B')
  assert.equal(log().filter((e) => e.kind === 'switch').length, 1)
  assert.ok(log().length >= before)
})

step('a typed draft is never submitted; a limit event triggers the switch')
await sw.switchNow('odin', 'fake-a')
check('manual switch to fake-a', () => assert.equal(storeTok(), 'dummy-A'))
rig('pane')
await waitFor('the new pane prompt', () => /❯/.test(cap()))
rig('type', 'say hi again')
await waitFor('the limit screen again', () => /Usage limit reached · continuing automatically/.test(cap()))
rig('typeonly', 'half typed')
await sleep(800)
const switchesBefore = log().filter((e) => e.kind === 'switch').length
await sleep(15_500) // the hard floor after the manual switch
const ev = sw.reportLimit('odin', { message: "You've hit your session limit · resets 7:49pm (America/New_York)", sessionId: 'outside-session-1' })
check('event accepted as a session limit', () => assert.deepEqual(ev, { accepted: true, limit: 'session', why: 'checking now' }))
await waitFor('the event switch', () => log().filter((e) => e.kind === 'switch').length > switchesBefore)
const sw2 = log().find((e) => e.kind === 'switch')
check('event switch fake-a -> fake-b, typed pane left alone', () => {
  assert.equal(`${sw2?.from}->${sw2?.to}`, 'fake-a->fake-b')
  assert.equal(sw2?.nudged, 0)
  // Claude Code puts a no-break space after the ❯.
  assert.match(cap(), /❯\s+half typed/)
})
check('the session outside Valkyrie is counted in the DM', () => assert.match(dms(), /1 session outside Valkyrie hit the limit/))
check('a non-account limit is ignored', () => assert.equal(sw.reportLimit('odin', { message: "You've hit your usage credit limit" }).accepted, false))

step('every account near its limit: no switch, one DM')
await sw.switchNow('odin', 'fake-a')
config({ ...base, dryRun: false, exclude: ['fake-b', 'fake-c', 'fake-d'] })
await sleep(15_500)
await sw.__test.tick(false)
check('exhausted logged and DMed, store stays on fake-a', () => {
  assert.equal(log()[0].kind, 'exhausted')
  assert.equal(storeTok(), 'dummy-A')
  assert.match(dms(), /Claude auto-switch: limit reached; no account has room, so odin stays on Fake A\./)
})

step('a /login sign-in pauses the host')
const s0 = store()
s0.claudeAiOauth.refreshToken = 'dummy-refresh-not-real'
writeFileSync(`${T}/store/.credentials.json.tmp`, JSON.stringify(s0), { mode: 0o600 })
renameSync(`${T}/store/.credentials.json.tmp`, `${T}/store/.credentials.json`)
config({ ...base, dryRun: false })
await sw.__test.tick(false)
const st = await sw.getStatus()
const odin = st.hosts.find((h) => h.host === 'odin')!
check('odin paused, grant left in place', () => {
  assert.equal(odin.paused, true)
  assert.equal(odin.owner, 'grant')
  assert.equal(store().claudeAiOauth.refreshToken, 'dummy-refresh-not-real')
  assert.match(dms(), /Claude auto-switch paused on odin: the live sign-in came from \/login/)
})

step('kill switch: nothing automatic runs')
sw.setKill(true)
const n = log().length
await sw.__test.tick(false)
check('kill switch holds', () => assert.equal(log().length, n))
sw.setKill(false)

step('resume takes the host over from the /login sign-in')
const r2 = await sw.resumeHost('odin')
check('resume switched to fake-b', () => {
  assert.deepEqual(r2, { ok: true, switchedTo: 'fake-b' })
  assert.equal(storeTok(), 'dummy-B')
  assert.equal(store().claudeAiOauth.refreshToken, null)
})

step('a pane that stops after the switch is continued by the sweep')
await sw.switchNow('odin', 'fake-a')
rig('pane')
await waitFor('the new pane prompt', () => /❯/.test(cap()))
rig('type', 'say hi late')
await waitFor('the late limit screen', () => /Usage limit reached · continuing automatically/.test(cap()))
// The store moves to fake-b behind the switcher's back, the way a request in
// flight on the old token comes back refused after the switch already ran.
const vb = JSON.parse(readFileSync(`${T}/sw/tokens/fake-b.json`, 'utf8'))
const moved = store()
moved.claudeAiOauth.accessToken = vb.accessToken
writeFileSync(`${T}/store/.credentials.json.tmp`, JSON.stringify(moved), { mode: 0o600 })
renameSync(`${T}/store/.credentials.json.tmp`, `${T}/store/.credentials.json`)
// Its StopFailure hook reports the limit; the active account (now fake-b)
// has room, so there is nothing to switch, only a pane to continue.
const late = sw.reportLimit('odin', { message: "You've hit your session limit · resets 8:09pm (America/New_York)", sessionId: 'late-1' })
check('late event accepted', () => assert.equal(late.accepted, true))
await waitFor('the continue entry', () => log().some((e) => e.kind === 'continue'))
check('the sweep continued the stopped pane on fake-b without a switch', () => {
  const c = log().find((e) => e.kind === 'continue')
  assert.equal(c?.to, 'fake-b')
  assert.equal(c?.nudged, 1)
  assert.equal(storeTok(), 'dummy-B')
})
await waitFor('the late reply on fake-b', () => /REPLY-FROM-ACCOUNT-B/.test(cap()))
sw.reportLimit('odin', { message: "You've hit your session limit", sessionId: 'late-2' })
await sleep(4000)
check('no second continue inside the cooldown', () => assert.equal(log().filter((e) => e.kind === 'continue').length, 1))

step('status shape')
const st2 = await sw.getStatus()
check('status lists hosts, accounts and recent entries, no token anywhere', () => {
  assert.equal(st2.hosts.length, 2)
  assert.equal(st2.hosts.find((h) => h.host === 'odin')?.active?.id, 'fake-b')
  assert.ok(st2.accounts.some((a) => a.id === 'fake-d' && (a.token.dead || a.why)))
  assert.ok(st2.recent.length > 0)
  const text = JSON.stringify(st2) + readFileSync(`${T}/sw/switches.log`, 'utf8') + readFileSync(`${T}/sw/state.json`, 'utf8') + dms()
  assert.doesNotMatch(text, /dummy-[ABCD]-token/)
})

step('routes over HTTP, and the CLI against them')
const express = (await import('express')).default
const { default: route } = await import('../src/routes/accountSwitch.ts')
const app = express()
app.use(express.json())
app.use('/api', route)
const srv = app.listen(0, '127.0.0.1')
await new Promise((r) => srv.once('listening', r))
const port = (srv.address() as { port: number }).port
const http = async (m: string, p: string, b?: unknown) => {
  const r = await fetch(`http://127.0.0.1:${port}/api${p}`, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })
  return [r.status, await r.json()] as const
}
const [gs, gb] = await http('GET', '/account-switch')
check('GET status 200 with hosts and accounts', () => {
  assert.equal(gs, 200)
  assert.equal(gb.hosts.length, 2)
  assert.ok(Array.isArray(gb.accounts) && Array.isArray(gb.recent))
})
const bad = [
  (await http('POST', '/account-switch/switch', { host: 'odin', account: 'fake-c' }))[0],
  (await http('POST', '/account-switch/switch', { host: 'nope', account: 'fake-c', confirm: true }))[0],
  (await http('POST', '/account-switch/switch', { host: 'odin', account: '../x', confirm: true }))[0],
]
check('switch without confirm, with a bad host or a bad id is refused', () => assert.deepEqual(bad, [400, 400, 400]))
const [ss, sb] = await http('POST', '/account-switch/switch', { host: 'odin', account: 'fake-c', confirm: true })
check('manual switch over HTTP', () => {
  assert.equal(ss, 200)
  assert.equal(sb.results[0].ok, true)
  assert.equal(storeTok(), 'dummy-C')
})
const [ds, db] = await http('POST', '/account-switch/switch', { host: 'odin', account: 'fake-d', confirm: true })
check('a refused token is not switched to', () => {
  assert.equal(ds, 409)
  assert.match(db.error, /refused/)
  assert.equal(storeTok(), 'dummy-C')
})
const [cs, cb] = await http('POST', '/account-switch/config', { thresholdPct: 96, bogus: 1 })
check('config patch applies known keys only', () => {
  assert.equal(cs, 200)
  assert.equal(cb.config.thresholdPct, 96)
  assert.equal(cb.config.enabled, true)
  assert.equal((cb.config as Record<string, unknown>).bogus, undefined)
})
assert.equal((await http('POST', '/account-switch/config', { bogus: 1 }))[0], 400)
const [ks, kb] = await http('POST', '/account-switch/kill', { on: true })
check('kill over HTTP', () => assert.deepEqual([ks, kb], [200, { killed: true }]))
await http('POST', '/account-switch/kill', { on: false })
const [ls, lb] = await http('POST', '/account-switch/limit-event?host=odin', { error: 'rate_limit', last_assistant_message: "You've hit your fast limit", session_id: 'x', cwd: '/secret/path' })
check('limit-event ignores a non-account limit', () => assert.deepEqual([ls, lb.accepted], [200, false]))
assert.equal((await http('POST', '/account-switch/limit-event', { last_assistant_message: "You've hit your session limit" }))[0], 400)
const [ps2] = await http('POST', '/account-switch/pause', { host: 'odin' })
check('pause over HTTP', () => assert.equal(ps2, 200))
const [lgs, lgb] = await http('GET', '/account-switch/log?limit=5')
check('log over HTTP, newest first', () => {
  assert.equal(lgs, 200)
  assert.equal(lgb.entries.length, 5)
  assert.equal(lgb.entries[0].kind, 'paused')
})
// Async: the API answering the CLI runs in this same process.
const { execFile } = await import('node:child_process')
const runCli = (...a: string[]) => new Promise<string>((resolve, reject) => {
  execFile('sh', [path.join(path.dirname(fileURLToPath(import.meta.url)), 'claude-switch.sh'), ...a], { env: { ...process.env, PORT: String(port) }, encoding: 'utf8' },
    (err, stdout, stderr) => (err ? reject(new Error(`${err.message} ${stderr}`)) : resolve(stdout)))
})
const cli = await runCli('status')
console.log(cli.replace(/^/gm, '    | '))
check('CLI status reads the API', () => {
  assert.match(cli, /auto-switch: on \| threshold 96%/)
  assert.match(cli, /odin  auto on  using Fake C/)
  assert.match(cli, /PAUSED: paused by hand/)
})
const cliLog = await runCli('log', '4')
console.log(cliLog.replace(/^/gm, '    | '))
check('CLI log prints ET times', () => assert.match(cliLog, / ET /))
srv.close()

console.log(`\n${ok} checks passed`)
process.exit(0)
