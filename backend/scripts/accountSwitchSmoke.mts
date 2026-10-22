/**
 * Account switcher decision tests (lib/accountSwitchCore.ts): pure functions
 * only, no files, network or tmux. Run on odin from a scratch copy:
 *
 *   node --import tsx scripts/accountSwitchSmoke.mts
 *
 * Pane screens below are real captures from Claude Code 2.1.283 in a throwaway
 * tmux pane against a loopback fake API (dummy tokens), trailing blanks cut.
 * scripts/fixtures/pane-screens.json adds 2.1.303 captures from the same rig
 * and the Windows console layouts thor's Continue-Stopped.ps1 reads.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  DEFAULT_CONFIG, activeTrigger, buildLiveCredentials, classifyLimitText, countRecent, decide, effectiveSession,
  eligibility, exhaustedMessage, fmtET, normalizeConfig, ownerOf, paneLimitState, parsePoolToken,
  parseRateLimitHeaders, pausedMessage, pickTarget, switchMessage,
  type AccountView, type HostView, type Quota, type SwitchConfig,
} from '../src/lib/accountSwitchCore.ts'

let passed = 0
const failures: string[] = []
const test = (name: string, fn: () => void) => {
  try {
    fn()
    passed++
  } catch (err) {
    failures.push(`${name}: ${(err as Error).message.split('\n').slice(0, 6).join(' | ')}`)
  }
}

const NOW = Date.parse('2026-10-18T20:00:00Z') // 4:00 PM ET
const H = 3600_000
const iso = (ms: number) => new Date(ms).toISOString()
const cfg = (over: Partial<SwitchConfig> = {}): SwitchConfig => ({ ...DEFAULT_CONFIG, enabled: true, dryRun: false, hosts: { thor: true, odin: true }, ...over })
const q = (sessionPct: number, weeklyPct = 20, over: Partial<Quota> = {}): Quota => ({
  sessionPct, weeklyPct, sessionResetsAt: iso(NOW + 2 * H), weeklyResetsAt: iso(NOW + 72 * H), status: sessionPct >= 100 ? 'rejected' : 'allowed', ...over,
})
const acct = (id: string, quota: Quota | null, over: Partial<AccountView> = {}, at = NOW - 30_000): AccountView => ({
  id, label: id.toUpperCase(), token: { present: true, dead: false, expiresAt: NOW + 300 * 24 * H },
  quota: quota ? { quota, at, source: 'probe' } : null, ...over,
})
const host = (over: Partial<HostView> = {}): HostView => ({
  host: 'thor', enabled: true, active: 'a', owner: 'pool', paused: false, pausedReason: null, lastSwitchAt: null, ...over,
})

// ------------------------------------------------------------------ config --

test('config: absent file is off and in dry run', () => {
  const c = normalizeConfig(null)
  assert.equal(c.enabled, false)
  assert.equal(c.dryRun, true)
  assert.equal(c.thresholdPct, 98)
  assert.deepEqual(c.hosts, { thor: true, odin: false })
})
test('config: only a literal true enables, only a literal false leaves dry run', () => {
  assert.equal(normalizeConfig({ enabled: 'yes' }).enabled, false)
  assert.equal(normalizeConfig({ enabled: 1 }).enabled, false)
  assert.equal(normalizeConfig({ enabled: true }).enabled, true)
  assert.equal(normalizeConfig({ dryRun: 0 }).dryRun, true)
  assert.equal(normalizeConfig({ dryRun: false }).dryRun, false)
})
test('config: numbers clamp, garbage falls back, target stays under threshold', () => {
  const c = normalizeConfig({ thresholdPct: 120, targetMaxPct: 'x', minIntervalMin: -4 })
  assert.equal(c.thresholdPct, 100)
  assert.equal(c.targetMaxPct, 90)
  assert.equal(c.minIntervalMin, 1)
  assert.equal(normalizeConfig({ thresholdPct: 80, targetMaxPct: 95 }).targetMaxPct, 79)
  assert.equal(normalizeConfig({ thresholdPct: '95' }).thresholdPct, 95)
})
test('config: id lists keep only plain ids, nudge text is one line', () => {
  const c = normalizeConfig({ order: ['seat-two', '../x', 3, 'Bad'], lastResort: ['pro-seat'], nudgeText: 'go\non\r\n' })
  assert.deepEqual(c.order, ['seat-two'])
  assert.deepEqual(c.lastResort, ['pro-seat'])
  assert.equal(c.nudgeText, 'go on')
  assert.equal(normalizeConfig({ nudgeText: '   ' }).nudgeText, DEFAULT_CONFIG.nudgeText)
})

// ------------------------------------------------------------ quota math --

test('quota: a passed reset empties the window', () => {
  assert.equal(effectiveSession(q(99, 20, { sessionResetsAt: iso(NOW - 1000) }), NOW), 0)
  assert.equal(effectiveSession(q(99), NOW), 99)
})
test('trigger: below threshold none, at threshold soft, rejected hard', () => {
  assert.equal(activeTrigger(q(97), cfg(), NOW), null)
  assert.deepEqual(activeTrigger(q(98), cfg(), NOW), { hard: false, why: 'session at 98%' })
  assert.equal(activeTrigger(q(100), cfg(), NOW)?.hard, true)
  assert.equal(activeTrigger(q(60, 20, { status: 'rejected' }), cfg(), NOW)?.hard, true)
  assert.equal(activeTrigger(q(20, 98), cfg(), NOW)?.why, 'weekly at 98%')
  assert.equal(activeTrigger(q(95), cfg({ thresholdPct: 95 }), NOW)?.hard, false)
})
test('trigger: a rejection whose window has reset is over', () => {
  assert.equal(activeTrigger(q(100, 20, { sessionResetsAt: iso(NOW - 60_000) }), cfg(), NOW), null)
})

// ------------------------------------------------------------- eligibility --

test('eligibility: token problems and limits exclude, with reasons', () => {
  assert.equal(eligibility(acct('x', q(5), { token: { present: false, dead: false, expiresAt: null } }), cfg(), NOW).why, 'no pool token')
  assert.equal(eligibility(acct('x', q(5), { token: { present: true, dead: true, expiresAt: null } }), cfg(), NOW).why, 'pool token rejected')
  assert.equal(eligibility(acct('x', q(5), { token: { present: true, dead: false, expiresAt: NOW + 1000 } }), cfg(), NOW).why, 'pool token expired')
  assert.equal(eligibility(acct('x', q(5, 99)), cfg(), NOW).why, 'weekly at 99%')
  assert.equal(eligibility(acct('x', q(90)), cfg(), NOW).why, 'session at 90%')
  assert.equal(eligibility(acct('x', q(100)), cfg(), NOW).ok, false)
  assert.equal(eligibility(acct('x', q(5)), cfg({ exclude: ['x'] }), NOW).why, 'excluded in config')
  const e = eligibility(acct('x', q(40)), cfg(), NOW)
  assert.equal(e.ok, true)
  assert.equal(e.room, 60)
})
test('eligibility: no reading is usable but unranked, old reading flagged', () => {
  const none = eligibility(acct('x', null), cfg(), NOW)
  assert.equal(none.ok, true)
  assert.equal(none.room, null)
  const old = eligibility(acct('x', q(10), {}, NOW - 3 * H), cfg(), NOW)
  assert.equal(old.ok, true)
  assert.equal(old.fresh, false)
})

// ------------------------------------------------------------------ pick ----

test('pick: most room wins, the active account is never picked', () => {
  const p = pickTarget([acct('a', q(99)), acct('b', q(40)), acct('c', q(10))], 'a', cfg(), NOW)
  assert.equal(p.target?.id, 'c')
  assert.deepEqual(p.ranked.map((r) => r.id), ['c', 'b', 'a'])
  assert.equal(p.ranked[2].why, 'active now')
})
test('pick: last resort comes after every usable account, but is used when alone', () => {
  const c = cfg({ lastResort: ['pro'] })
  assert.equal(pickTarget([acct('a', q(99)), acct('pro', q(0)), acct('b', q(70))], 'a', c, NOW).target?.id, 'b')
  assert.equal(pickTarget([acct('a', q(99)), acct('pro', q(0)), acct('b', q(95))], 'a', c, NOW).target?.id, 'pro')
})
test('pick: fresh readings beat old ones and missing ones', () => {
  const p = pickTarget([acct('a', q(99)), acct('old', q(1), {}, NOW - 2 * H), acct('none', null), acct('fresh', q(50))], 'a', cfg(), NOW)
  assert.deepEqual(p.ranked.filter((r) => r.ok).map((r) => r.id), ['fresh', 'old', 'none'])
})
test('pick: ties break on weekly room, then config order', () => {
  assert.equal(pickTarget([acct('a', q(99)), acct('b', q(10, 70)), acct('c', q(10, 30))], 'a', cfg(), NOW).target?.id, 'c')
  assert.equal(pickTarget([acct('a', q(99)), acct('b', q(10)), acct('c', q(10))], 'a', cfg({ order: ['c', 'b'] }), NOW).target?.id, 'c')
})
test('pick: dead, expired, weekly-exhausted and full accounts are skipped', () => {
  const p = pickTarget([
    acct('a', q(99)),
    acct('dead', q(0), { token: { present: true, dead: true, expiresAt: null } }),
    acct('week', q(0, 100)),
    acct('full', q(100)),
    acct('ok', q(85)),
  ], 'a', cfg(), NOW)
  assert.equal(p.target?.id, 'ok')
})
test('pick: an account whose window reset is usable again', () => {
  const p = pickTarget([acct('a', q(99)), acct('b', q(100, 20, { sessionResetsAt: iso(NOW - 5000) }))], 'a', cfg(), NOW)
  assert.equal(p.target?.id, 'b')
})
test('pick: nothing usable reports the earliest relief', () => {
  const p = pickTarget([
    acct('a', q(99)),
    acct('b', q(95, 20, { sessionResetsAt: iso(NOW + 40 * 60_000) })),
    acct('c', q(20, 99, { weeklyResetsAt: iso(NOW + 20 * 60_000) })),
  ], 'a', cfg(), NOW)
  assert.equal(p.target, null)
  assert.deepEqual(p.earliestRelief, { id: 'c', at: NOW + 20 * 60_000 })
})

// -------------------------------------------------------------- decide -----

const three = (active: Quota) => [acct('a', active), acct('b', q(30)), acct('c', q(60))]

test('decide: off, killed, host off', () => {
  assert.equal(decide({ cfg: cfg({ enabled: false }), killed: false, host: host(), accounts: three(q(100)), now: NOW }).action, 'none')
  assert.equal(decide({ cfg: cfg(), killed: true, host: host(), accounts: three(q(100)), now: NOW }).action, 'none')
  assert.equal(decide({ cfg: cfg({ hosts: { thor: false, odin: true } }), killed: false, host: host(), accounts: three(q(100)), now: NOW }).action, 'none')
})
test('decide: paused, /login sign-in, unknown token and unreachable host never write', () => {
  assert.equal(decide({ cfg: cfg(), killed: false, host: host({ paused: true, pausedReason: 'x' }), accounts: three(q(100)), now: NOW }).action, 'blocked')
  const g = decide({ cfg: cfg(), killed: false, host: host({ owner: 'grant' }), accounts: three(q(100)), now: NOW })
  assert.equal(g.action, 'blocked')
  assert.equal(decide({ cfg: cfg(), killed: false, host: host({ owner: 'unknown' }), accounts: three(q(100)), now: NOW }).action, 'blocked')
  assert.equal(decide({ cfg: cfg(), killed: false, host: host({ owner: 'unreachable' }), accounts: three(q(100)), now: NOW }).action, 'none')
})
test('decide: under the threshold nothing happens', () => {
  assert.deepEqual(decide({ cfg: cfg(), killed: false, host: host(), accounts: three(q(97)), now: NOW }), { action: 'none', reason: 'active account has room' })
})
test('decide: at the threshold, switch to the most room', () => {
  const d = decide({ cfg: cfg(), killed: false, host: host(), accounts: three(q(98)), now: NOW })
  assert.deepEqual(d, { action: 'switch', from: 'a', to: 'b', reason: 'session at 98%', hard: false })
})
test('decide: threshold is configurable down to 95', () => {
  assert.equal(decide({ cfg: cfg({ thresholdPct: 95 }), killed: false, host: host(), accounts: three(q(95)), now: NOW }).action, 'switch')
  assert.equal(decide({ cfg: cfg({ thresholdPct: 100 }), killed: false, host: host(), accounts: three(q(99)), now: NOW }).action, 'none')
})
test('decide: a stale reading of the active account is not acted on', () => {
  const accounts = [acct('a', q(99), {}, NOW - 10 * 60_000), acct('b', q(1))]
  assert.equal(decide({ cfg: cfg(), killed: false, host: host(), accounts, now: NOW }).reason, 'no fresh reading for the active account')
})
test('decide: minimum interval holds a soft switch, a hard limit gets through after the floor', () => {
  const recent = host({ lastSwitchAt: NOW - 5 * 60_000 })
  assert.equal(decide({ cfg: cfg(), killed: false, host: recent, accounts: three(q(98)), now: NOW }).action, 'blocked')
  assert.equal(decide({ cfg: cfg(), killed: false, host: recent, accounts: three(q(100)), now: NOW }).action, 'switch')
  const veryRecent = host({ lastSwitchAt: NOW - 20_000 })
  assert.equal(decide({ cfg: cfg(), killed: false, host: veryRecent, accounts: three(q(100)), now: NOW }).action, 'blocked')
})
test('decide: no daily cap, a hard limit switches after any number of switches', () => {
  const d = decide({ cfg: cfg(), killed: false, host: host({ lastSwitchAt: NOW - 5 * 60_000 }), accounts: three(q(100)), now: NOW })
  assert.equal(d.action, 'switch')
})
test('decide: every account near its limit is exhausted, not a switch', () => {
  const d = decide({ cfg: cfg(), killed: false, host: host(), accounts: [acct('a', q(100)), acct('b', q(93)), acct('c', q(20, 99))], now: NOW })
  assert.equal(d.action, 'exhausted')
})
test('decide: no live sign-in is a hard switch', () => {
  const d = decide({ cfg: cfg(), killed: false, host: host({ active: null, owner: 'missing' }), accounts: three(q(10)), now: NOW })
  assert.equal(d.action, 'switch')
  assert.equal(d.action === 'switch' && d.hard, true)
})
test('decide: a limit event confirmed by a later reading switches', () => {
  const accounts = [acct('a', q(100), {}, NOW - 1000), acct('b', q(5))]
  const d = decide({ cfg: cfg(), killed: false, host: host(), accounts, now: NOW, event: { at: NOW - 5000, limit: 'session' } })
  assert.equal(d.action, 'switch')
})
test('decide: a limit event contradicted by a later reading is stale', () => {
  const accounts = [acct('a', q(10), {}, NOW - 1000), acct('b', q(5))]
  const d = decide({ cfg: cfg(), killed: false, host: host(), accounts, now: NOW, event: { at: NOW - 5000, limit: 'session' } })
  assert.equal(d.reason, 'limit event predates the last switch')
})
test('decide: a limit event with no reading counts unless it came right after a switch', () => {
  const accounts = [acct('a', null), acct('b', q(5))]
  const fresh = decide({ cfg: cfg(), killed: false, host: host(), accounts, now: NOW, event: { at: NOW - 1000, limit: 'session' } })
  assert.equal(fresh.action, 'switch')
  const afterSwitch = decide({ cfg: cfg(), killed: false, host: host({ lastSwitchAt: NOW - 10_000 }), accounts, now: NOW, event: { at: NOW - 5000, limit: 'session' } })
  assert.equal(afterSwitch.action, 'none')
})
test('decide: an Opus limit switches even when the account-wide reading has room', () => {
  const accounts = [acct('a', q(30), {}, NOW - 1000), acct('b', q(5))]
  const d = decide({ cfg: cfg(), killed: false, host: host({ lastSwitchAt: NOW - H }), accounts, now: NOW, event: { at: NOW - 5000, limit: 'opus' } })
  assert.equal(d.action, 'switch')
})

// ------------------------------------------------------------ limit text ---

test('limit text: account limits match, other limits do not', () => {
  assert.equal(classifyLimitText("You've hit your session limit · resets 7:17pm (America/New_York)"), 'session')
  assert.equal(classifyLimitText("You've hit your weekly limit · resets Mon 9am"), 'weekly')
  assert.equal(classifyLimitText("You've hit your Opus limit"), 'opus')
  assert.equal(classifyLimitText("You've hit your Sonnet limit · progress saved"), 'sonnet')
  assert.equal(classifyLimitText("You've hit your limit · resets 7:25pm (America/New_York)"), 'generic')
  assert.equal(classifyLimitText('You’ve hit your session limit'), 'session')
  assert.equal(classifyLimitText("You've hit your usage credit limit"), null)
  assert.equal(classifyLimitText("You've hit your fast limit"), null)
  assert.equal(classifyLimitText("You've hit your team's shared budget. /model to switch models."), null)
  assert.equal(classifyLimitText('Context limit reached'), null)
  assert.equal(classifyLimitText(undefined), null)
})
test('limit text: the Fable limit and the "reached" wording of 2.1.280 to 2.1.303', () => {
  assert.equal(classifyLimitText("You've hit your Fable limit · resets Wed 9am"), 'fable')
  assert.equal(classifyLimitText("You've reached your Fable limit."), 'fable')
  assert.equal(classifyLimitText("You've reached your session limit"), 'session')
  assert.equal(classifyLimitText("You've reached your usage limit"), null)
  assert.equal(classifyLimitText("You've reached your monthly spend limit"), null)
})
test('decide: a Fable limit is model-wide like Opus, so a reading with room does not cancel it', () => {
  const accounts = [acct('a', q(30), {}, NOW - 1000), acct('b', q(5))]
  const d = decide({ cfg: cfg(), killed: false, host: host({ lastSwitchAt: NOW - H }), accounts, now: NOW, event: { at: NOW - 5000, limit: 'fable' } })
  assert.equal(d.action, 'switch')
})

// ---------------------------------------------------------------- panes ----

const RULE = '─'.repeat(150)
const HEAD = [' ▐▛███▛█   Claude Code v2.1.283', '▝▜██████▀  Haiku 4.5 · Claude Team', ' ▝▝   ▝▝   /tmp/ccsw-svc/work', '']
const LIMIT_BLOCK = [
  '❯ say hi',
  "  ⎿  You've hit your session limit · resets 7:49pm (America/New_York)",
  '     Continuing automatically at 7:49pm · esc to cancel',
  '',
  '● Usage limit reached · continuing automatically at 7:49pm · esc or type to cancel',
  '',
  '✻ Crunched for 0s · done 4:49 PM',
  '',
]
const FOOT_ARMED = ['  ⚠ Usage limit reached · continuing automatically at 7:49pm · esc to cancel', '  ⏸ manual mode on · ? for shortcuts · ← for agents']
const FOOT = ['  ⏸ manual mode on · ? for shortcuts · ← for agents']
const screen = (...parts: string[][]) => parts.flat().join('\n')

// Captured: fullscreen (CLAUDE_CODE_NO_FLICKER=1, like every Valkyrie pane), armed, empty prompt.
// Fullscreen pads the rows between the last message and the input box with blanks.
const BLANKS = Array.from({ length: 24 }, () => '')
const ARMED = screen(HEAD, LIMIT_BLOCK, BLANKS, [' '.repeat(48) + "tmux focus-events off · add 'set -g focus-events on' to ~/.tmux.conf and reattach for focus tracking", RULE, '❯ ', RULE], FOOT_ARMED)
// Captured: the same pane with "half typed" in the prompt. Typing does not disarm it.
const TYPED = screen(HEAD, LIMIT_BLOCK, [RULE, '❯ half typed', RULE], FOOT_ARMED)
// Captured: Esc pressed. The person cancelled the wait.
const CANCELLED = screen(HEAD, [
  '❯ say hi',
  "  ⎿  You've hit your session limit · resets 7:49pm (America/New_York)",
  '     Your admin can enable extra usage at claude.ai/admin-settings/usage.',
  '',
  '● Usage limit reached · continuing automatically at 7:49pm · esc or type to cancel',
  '',
  '✻ Crunched for 0s · done 4:49 PM',
  '',
  '● Automatic continue cancelled · /rate-limit-options to re-arm',
  '',
  ' '.repeat(88) + 'Automatic continue cancelled · /rate-limit-options to re-arm',
  RULE, '❯ ', RULE,
], FOOT)
// Captured by the investigation: inline renderer, armed.
const INLINE = screen(HEAD, [
  '❯ say hi',
  "  ⎿  You've hit your session limit · resets 7:17pm (America/New_York)",
  '     Continuing automatically at 7:17pm · esc to cancel',
  '● Usage limit reached · continuing automatically at 7:17pm · esc or type to cancel',
  '✻ Baked for 0s · done 4:17 PM',
  RULE, '❯ ' + ' '.repeat(150), RULE,
], FOOT_ARMED)
// Armed, with Claude Code's right-aligned hint over the input box.
const HINTED = screen(HEAD, LIMIT_BLOCK, [' '.repeat(120) + 'Ctrl+Y to paste deleted text', RULE, '❯ ', RULE], FOOT_ARMED)
// Captured: a fresh session, nothing happened.
const IDLE = screen(HEAD, ['', ' '.repeat(51) + "tmux detected · scroll with PgUp/PgDn · or add 'set -g mouse on' to ~/.tmux.conf for wheel scroll", RULE, '❯ ', RULE], FOOT)
// The limit happened earlier, and the session has moved on since.
const MOVED_ON = screen(HEAD, LIMIT_BLOCK, ['❯ continue', '', '● REPLY-FROM-ACCOUNT-B', '', RULE, '❯ ', RULE], FOOT)
// A headless-style limit line with no auto-continue (autoContinueAtUsageLimit off).
const NOT_ARMED = screen(HEAD, ['❯ say hi', "  ⎿  You've hit your limit · resets 7:25pm (America/New_York)", '', RULE, '❯ ', RULE], FOOT)
// A permission dialog replaces the input box: no prompt on screen.
const DIALOG = screen(HEAD, LIMIT_BLOCK, [
  '╭' + '─'.repeat(60) + '╮', '│ Bash command                                               │', '│   rm -rf build                                             │',
  '│ Do you want to proceed?                                    │', '│ ❯ 1. Yes                                                   │', '│   2. No                                                    │', '╰' + '─'.repeat(60) + '╯',
])
// A multi-line draft in the prompt.
const MULTILINE = screen(HEAD, LIMIT_BLOCK, [RULE, '❯ ', '  second line of a draft', RULE], FOOT_ARMED)
// The old boxed prompt, empty, armed.
const BOXED = screen(HEAD, LIMIT_BLOCK, ['╭' + '─'.repeat(60) + '╮', '│ >                                                          │', '╰' + '─'.repeat(60) + '╯'], FOOT_ARMED)
// A usage-credit limit is not an account limit.
const CREDITS = screen(HEAD, ['❯ say hi', "  ⎿  You've hit your usage credit limit", '', RULE, '❯ ', RULE], FOOT)

test('pane: armed with an empty prompt is nudged, limit read through blank rows', () => {
  const v = paneLimitState(ARMED)
  assert.equal(v.nudge, true)
  assert.equal(v.limit, 'session')
  assert.equal(v.armed, true)
  assert.equal(v.promptEmpty, true)
})
test('pane: inline renderer, armed, is nudged', () => assert.equal(paneLimitState(INLINE).nudge, true))
test('pane: a hint line over the prompt does not hide the limit', () => {
  const v = paneLimitState(HINTED)
  assert.equal(v.nudge, true)
  assert.equal(v.limit, 'session')
})
test('pane: text in the prompt is never submitted', () => {
  const v = paneLimitState(TYPED)
  assert.equal(v.nudge, false)
  assert.equal(v.why, 'prompt holds typed text')
  assert.equal(paneLimitState(MULTILINE).nudge, false)
})
test('pane: a cancelled wait is left alone', () => assert.equal(paneLimitState(CANCELLED).nudge, false))
test('pane: idle and moved-on sessions are left alone', () => {
  assert.equal(paneLimitState(IDLE).nudge, false)
  assert.equal(paneLimitState(IDLE).promptFound, true)
  assert.equal(paneLimitState(MOVED_ON).nudge, false)
})
test('pane: a limit with no auto-continue is still nudged', () => {
  const v = paneLimitState(NOT_ARMED)
  assert.equal(v.nudge, true)
  assert.equal(v.limit, 'generic')
  assert.equal(v.armed, false)
})
test('pane: an open dialog means no prompt, so no nudge', () => {
  const v = paneLimitState(DIALOG)
  assert.equal(v.promptFound, false)
  assert.equal(v.nudge, false)
})
test('pane: the boxed prompt is read too', () => assert.equal(paneLimitState(BOXED).nudge, true))
test('pane: non-account limits and empty screens are left alone', () => {
  assert.equal(paneLimitState(CREDITS).nudge, false)
  assert.equal(paneLimitState('').nudge, false)
  assert.equal(paneLimitState('$ ls\nfile\n$ ').nudge, false)
})
test('pane: CRLF screens read the same', () => assert.equal(paneLimitState(ARMED.replace(/\n/g, '\r\n')).nudge, true))

// The shared screens: recorded 2.1.303 captures, Windows console layouts, and the ones above. thor's
// Continue-Stopped.ps1 is held to the same file by Test-ContinueStopped.ps1.
const SHARED = JSON.parse(readFileSync(new URL('./fixtures/pane-screens.json', import.meta.url), 'utf8')) as {
  screens: Array<{ name: string; screen: string; expect: { nudge: boolean; limit: string | null; armed: boolean; promptFound: boolean; promptEmpty: boolean } }>
}
test('pane: the shared fixture file has the recorded 2.1.303 and console screens', () => {
  assert.ok(SHARED.screens.length >= 20)
  assert.ok(SHARED.screens.some((s) => s.name === 'rec-2.1.303-fullscreen-armed'))
  assert.ok(SHARED.screens.some((s) => s.name.startsWith('win-console-')))
})
for (const s of SHARED.screens) {
  test(`pane (shared): ${s.name}`, () => {
    const v = paneLimitState(s.screen)
    assert.deepEqual({ nudge: v.nudge, limit: v.limit, armed: v.armed, promptFound: v.promptFound, promptEmpty: v.promptEmpty }, s.expect, v.why)
  })
}
test('pane: the 2.1.303 two-line banner under the prompt reads as armed', () => {
  const armed = SHARED.screens.find((s) => s.name === 'rec-2.1.303-fullscreen-armed')!.screen
  // the limit line scrolled off: only the banner under the input box is left to go on
  const cut = armed.split('\n').filter((l) => !/hit your session limit/.test(l)).join('\n')
  const v = paneLimitState(cut)
  assert.equal(v.armed, true)
  assert.equal(v.nudge, true)
})

// ------------------------------------------------------------- headers ----

const hdr = (o: Record<string, string>) => (n: string) => o[n] ?? null
test('headers: a 429 five_hour rejection reads as a full session', () => {
  const r = parseRateLimitHeaders(hdr({
    'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    'anthropic-ratelimit-unified-5h-utilization': '1.0', 'anthropic-ratelimit-unified-5h-reset': '1792364400',
    'anthropic-ratelimit-unified-7d-utilization': '0.40',
  }))
  assert.equal(r?.sessionPct, 100)
  assert.equal(r?.weeklyPct, 40)
  assert.equal(r?.status, 'rejected')
  assert.equal(r?.sessionResetsAt, new Date(1792364400 * 1000).toISOString())
})
test('headers: a rejection with only the claim still names the window', () => {
  const r = parseRateLimitHeaders(hdr({ 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-representative-claim': 'five_hour', 'anthropic-ratelimit-unified-reset': '1792364400' }))
  assert.equal(r?.sessionPct, 100)
  assert.equal(r?.sessionResetsAt, new Date(1792364400 * 1000).toISOString())
})
test('headers: none at all is no reading', () => assert.equal(parseRateLimitHeaders(hdr({})), null))

// --------------------------------------------------------- credentials ----

const TOK = 'pool-token-' + 'x'.repeat(40)
test('vault entry: the sign-in automation\'s record reads', () => {
  const t = parsePoolToken(JSON.stringify({ accountId: 'seat-two', accessToken: TOK, expiresAt: 1823900000000, subscriptionType: 'team', label: 'Seat Two' }), 'seat-two')
  assert.equal(t?.accessToken, TOK)
  assert.equal(t?.expiresAt, 1823900000000)
  assert.deepEqual(t?.scopes, ['user:inference'])
  assert.equal(t?.label, 'Seat Two')
})
test('vault entry: other field names, seconds and ISO expiry', () => {
  assert.equal(parsePoolToken(JSON.stringify({ token: TOK, expiresAt: 1823900000 }), 'x')?.expiresAt, 1823900000000)
  assert.equal(parsePoolToken(JSON.stringify({ claudeAiOauth: { accessToken: TOK, expiresAt: '2027-10-18T00:00:00Z' } }), 'x')?.expiresAt, Date.parse('2027-10-18T00:00:00Z'))
})
test('vault entry: a full grant, a short token and junk are refused', () => {
  assert.equal(parsePoolToken(JSON.stringify({ accessToken: TOK, refreshToken: 'refresh-zzzz' }), 'x'), null)
  assert.equal(parsePoolToken(JSON.stringify({ claudeAiOauth: { accessToken: TOK, refreshToken: 'r' } }), 'x'), null)
  assert.equal(parsePoolToken(JSON.stringify({ accessToken: 'short' }), 'x'), null)
  assert.equal(parsePoolToken('not json', 'x'), null)
  assert.equal(parsePoolToken('[1,2]', 'x'), null)
})
test('live file: claudeAiOauth replaced, every other key kept', () => {
  const t = parsePoolToken(JSON.stringify({ accessToken: TOK, expiresAt: NOW + 300 * 24 * H, subscriptionType: 'team', rateLimitTier: 'default_claude_max_5x' }), 'x')!
  const before = JSON.stringify({ claudeAiOauth: { accessToken: 'old', refreshToken: 'old-r', expiresAt: 1 }, mcpOAuth: { srv: { a: 1 } }, extra: [1, 2] })
  const out = JSON.parse(buildLiveCredentials(before, t, NOW))
  assert.deepEqual(out.mcpOAuth, { srv: { a: 1 } })
  assert.deepEqual(out.extra, [1, 2])
  assert.equal(out.claudeAiOauth.accessToken, TOK)
  assert.equal(out.claudeAiOauth.refreshToken, null)
  assert.equal(out.claudeAiOauth.expiresAt, NOW + 300 * 24 * H)
  assert.equal(out.claudeAiOauth.rateLimitTier, 'default_claude_max_5x')
})
test('live file: no expiry on record writes a year, never a short one', () => {
  const t = parsePoolToken(JSON.stringify({ accessToken: TOK }), 'x')!
  const out = JSON.parse(buildLiveCredentials(null, t, NOW))
  assert.ok(out.claudeAiOauth.expiresAt > NOW + 360 * 24 * H)
  assert.deepEqual(Object.keys(out), ['claudeAiOauth'])
  assert.equal(JSON.parse(buildLiveCredentials('{broken', t, NOW)).claudeAiOauth.accessToken, TOK)
})
test('owner: missing, /login grant, pool, unknown, unreadable', () => {
  const pool = [{ id: 'seat-two', accessToken: TOK }]
  assert.deepEqual(ownerOf(null, pool), { owner: 'missing', account: null })
  assert.deepEqual(ownerOf('{}', pool), { owner: 'missing', account: null })
  assert.deepEqual(ownerOf(JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r' } }), pool), { owner: 'grant', account: null })
  assert.deepEqual(ownerOf(JSON.stringify({ claudeAiOauth: { accessToken: TOK, refreshToken: null } }), pool), { owner: 'pool', account: 'seat-two' })
  assert.deepEqual(ownerOf(JSON.stringify({ claudeAiOauth: { accessToken: TOK, refreshToken: '' } }), pool), { owner: 'pool', account: 'seat-two' })
  assert.deepEqual(ownerOf(JSON.stringify({ claudeAiOauth: { accessToken: 'other' } }), pool), { owner: 'unknown', account: null })
  assert.deepEqual(ownerOf('{oops', pool), { owner: 'unknown', account: null })
})

// ------------------------------------------------------------ messages ----

test('times: New York time labeled ET, weekday when not today', () => {
  assert.equal(fmtET(NOW, NOW), '4:00 PM ET')
  assert.equal(fmtET(Date.parse('2026-10-19T13:30:00Z'), NOW), 'Mon 9:30 AM ET')
  // Standard time after Nov 1, 2026: 19:00Z is 2:00 PM.
  assert.equal(fmtET(Date.parse('2026-11-10T19:00:00Z'), Date.parse('2026-11-10T15:00:00Z')), '2:00 PM ET')
  assert.equal(fmtET(null, NOW), 'unknown')
})
test('counts: switches in the last 24 hours', () => {
  assert.equal(countRecent([NOW - 25 * H, NOW - 23 * H, NOW - 60_000, NOW + 1000], NOW), 2)
})
test('messages: plain, ET times, no em dash', () => {
  const sw = switchMessage({
    host: 'thor', from: { label: 'Seat One (work)', quota: q(98) }, to: { label: 'Seat Two', quota: q(4, 31) },
    reason: 'session at 98%', dryRun: false, nudged: 2, outside: 1,
  }, NOW)
  assert.match(sw, /^Switched thor from Seat One \(work\) \(session 98%, weekly 20%, resets 6:00 PM ET\) to Seat Two \(session 4%, weekly 31%/)
  assert.match(sw, /Continued 2 stopped panes\./)
  assert.match(sw, /1 session outside Valkyrie hit the limit; thor continues it once its prompt is empty\./)
  const odinOut = switchMessage({ host: 'odin', from: null, to: { label: 'B', quota: null }, reason: 'x', dryRun: false, nudged: 0, outside: 2 }, NOW)
  assert.match(odinOut, /2 sessions outside Valkyrie hit the limit and need a manual continue\./)
  const dry = switchMessage({ host: 'odin', from: null, to: { label: 'B', quota: null }, reason: 'x', dryRun: true, nudged: 3, outside: 2 }, NOW)
  assert.match(dry, /^Dry run: would switch odin to B \(no reading\)/)
  assert.doesNotMatch(dry, /Continued/)
  const ex = exhaustedMessage('thor', 'Seat Two', 'limit reached; no account has room', { label: 'Seat Three', at: NOW + 40 * 60_000 }, NOW)
  assert.equal(ex, 'Claude auto-switch: limit reached; no account has room, so thor stays on Seat Two. Earliest relief: Seat Three at 4:40 PM ET.')
  const pz = pausedMessage('thor', 'the live sign-in came from /login')
  for (const m of [sw, dry, ex, pz]) assert.doesNotMatch(m, /—/)
})

console.log(`${passed} passed, ${failures.length} failed`)
for (const f of failures) console.log('FAIL', f)
process.exit(failures.length ? 1 : 0)
