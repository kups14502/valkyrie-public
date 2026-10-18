// ACCOUNTS: the Claude account switcher's controls on AI > Usage
// (src/v2/screens/Accounts.tsx) against a fake switcher in the backend's own
// shapes (routes/accountSwitch.ts, routes/accountSignin.ts). GET
// /api/account-switch and GET /api/account-switch/signin are mocked from one
// mutable state; every write (config, switch, resume, kill, sign-in, the code,
// cancel) is caught in the browser and answered there, so nothing reaches
// odin, and the write tests change the state the way the switcher would, so
// the screen's re-read shows what was written. The rest of AI > Usage reads
// live through the probe.
//
//   view          both hosts' accounts, per-host auto, the next picks, the threshold,
//                 auto on, sign-in states, the last switches in ET (a UTC time
//                 converted, config entries left out), inside the viewport (phone, desktop)
//   switch        Switch now, pick, Confirm: 200 (the card moves, panes continued),
//                 500, and a 200 whose result says the host refused (the confirm stays)
//   cancel        Switch now then Cancel, and an armed Re-sign in left alone: no write
//   auto          the auto-switch toggle: 200 and 403
//   threshold     lower it three steps, Save
//   host-auto     one host's own auto-switch
//   signin        Re-sign in (two taps), the steps, the code box (refuses a code
//                 without #), the code sent and cleared: 200; a 429; Cancel
//   edge          dry run, a /login sign-in on a host, a pause with Resume (409),
//                 no next pick with the switcher's reason, no other usable account
//   kill          the kill switch: Remove (two taps)
//   missing       the routes are not on odin yet (404): a quiet note, no errors

import { sleep } from '../lib/cdp.mjs'
import { layoutReport } from '../lib/checks.mjs'

const ok = (body, status = 200) => ({ status, body })
const REFUSED = 'e2e refused this write'
const ROUTE = '/m/ai/usage'
const iso = (ms) => new Date(ms).toISOString()
const MIN = 60_000
const DAY = 86_400_000
/** 2026-10-14 15:03 UTC is 11:03 AM in New York (daylight time) */
const OLD_SWITCH = '2026-10-14T15:03:00.000Z'
const OLD_SWITCH_ET = 'Oct 14 11:03 AM ET'
const CODE = 'e2e-code#e2e-state'

/** "3:04 PM ET" for a time today in New York, as the screen writes it */
const etClock = (ms) => `${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(ms)} ET`

/** GET /api/account-switch (generic names only: this repo is public). */
function switchState(over = {}) {
  const now = Date.now()
  const quota = (s, w) => ({ sessionPct: s, weeklyPct: w, sessionResetsAt: iso(now + 50 * MIN), weeklyResetsAt: iso(now + 3 * DAY), status: 'allowed' })
  const acct = (id, letter, expiresIn, q, eligible, why, activeOn = []) => ({
    id, label: `Account ${letter}`, email: `${letter.toLowerCase()}@example.invalid`,
    token: { present: true, dead: false, expiresAt: iso(now + expiresIn) },
    quota: q, quotaAt: q ? iso(now - MIN) : null, quotaSource: q ? 'probe' : null, eligible, why, activeOn,
  })
  const host = (h, enabled, active, lastSwitchAt, next, extra = {}) => ({
    host: h, enabled, active, owner: active ? 'pool' : 'unknown', adopted: true, paused: false, pausedReason: null,
    lastSwitchAt, lastDryRunAt: null, switches24h: 1, checkedAt: iso(now - MIN), lastError: null,
    next, nextReason: next ? 'most room' : 'no other account', ...extra,
  })
  return {
    enabled: true,
    dryRun: false,
    killed: false,
    config: { enabled: true, dryRun: false, hosts: { thor: true, odin: false }, thresholdPct: 98, targetMaxPct: 90, weeklyMaxPct: 98, minIntervalMin: 10, exclude: [] },
    vault: { dir: '/e2e/vault', exists: true, modeOk: true, entries: 4, badFiles: [] },
    hosts: [
      host('thor', true, { id: 'acct-a', label: 'Account A' }, iso(now - 40 * MIN), { id: 'acct-b', label: 'Account B' }),
      host('odin', false, { id: 'acct-b', label: 'Account B' }, iso(now - 3 * 60 * MIN), { id: 'acct-c', label: 'Account C' }),
    ],
    accounts: [
      acct('acct-a', 'A', 300 * DAY, quota(96, 41), false, 'session at 96%', ['thor']),
      acct('acct-b', 'B', 300 * DAY, quota(4, 20), true, 'ok', ['odin']),
      acct('acct-c', 'C', 9 * DAY, quota(30, 60), true, 'ok'),
      acct('acct-d', 'D', -DAY, null, false, 'pool token expired'),
    ],
    recent: [
      { at: iso(now - 30 * MIN), kind: 'config', host: null, from: null, to: null, reason: 'config changed: enabled', ok: true },
      { at: iso(now - 40 * MIN), kind: 'switch', host: 'thor', from: 'acct-c', to: 'acct-a', reason: 'session at 98%', ok: true, fromPct: 98, toPct: 2, nudged: 2 },
      { at: OLD_SWITCH, kind: 'error', host: 'odin', from: 'acct-a', to: 'acct-b', reason: 'limit reached', ok: false, detail: 'target probe 401' },
    ],
    ...over,
  }
}

/** One sign-in request as GET /api/account-switch/signin lists it. */
function request(id, accountId, stage, over = {}) {
  const now = iso(Date.now())
  return {
    id, accountId, label: `Account ${accountId.slice(-1).toUpperCase()}`, email: `${accountId.slice(-1)}@example.invalid`,
    mode: 'token', target: 'vault', stage, detail: null, fallbackReason: null, needsCode: stage === 'needs-code', dmSent: false,
    startedAt: now, updatedAt: now, finishedAt: null, ok: null, vault: null, ...over,
  }
}

const findAcct = (st, id) => st.accounts.find((a) => a.id === id)
const findHost = (st, id) => st.hosts.find((h) => h.host === id)

async function shellUp(page) {
  await page.waitFor(() => document.querySelector('.vl-nav[data-ready]') || document.querySelector('.vl-setbar'), { timeout: 12_000, message: 'the v2 shell did not come up' })
}

/** Waits (Node side) until the page has sent `n` writes; returns the n-th. */
async function waitW(page, n, timeout = 6000) {
  const t0 = Date.now()
  while (page.writes.length < n && Date.now() - t0 < timeout) await sleep(50)
  if (page.writes.length < n) throw new Error(`expected ${n} write(s), the page sent ${page.writes.length}`)
  return page.writes[n - 1]
}

/** Sets an input's value the way typing would (React sees an input event). */
function setValue(sel, v) {
  const el = document.querySelector(sel)
  if (!el) return false
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return true
}

const text = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? e.textContent.replace(/\\s+/g, ' ').trim() : null })()`
const host = (id) => `.va-host[data-host="${id}"]`
const acctRow = (id) => `.va-acct[data-acct="${id}"]`

/**
 * Opens AI > Usage over the fake switcher. `status(st)` may answer the status
 * GET some other way (a 404); `onWrite(w, st, sg)` answers the writes; `sg` is
 * the sign-in list.
 */
async function openSwitcher(t, { state, signins, status, onWrite, device } = {}) {
  const st = state ?? switchState()
  const sg = signins ?? { requests: [], vault: [] }
  const page = await t.page(device ? { device } : {})
  page.mock('/api/account-switch', () => (status ? status(st) : ok(st)))
  page.mock('/api/account-switch/signin', () => (status ? status(sg) : ok(sg)))
  page.onWrite((w) => (onWrite ? onWrite(w, st, sg) : undefined))
  await page.goto(ROUTE)
  await shellUp(page)
  return { page, st, sg }
}

async function switcherUp(page) {
  await page.waitFor(text(`${host('thor')} .va-now b`), { timeout: 12_000, message: 'the switcher panel never showed thor\'s account' })
}

function viewTest(device) {
  return {
    name: `accounts:view:${device}`,
    group: 'accounts',
    device,
    timeout: 45_000,
    async run(t) {
      const { page, st } = await openSwitcher(t, { device })
      await switcherUp(page)
      const r = await page.eval(() => {
        const q = (s) => document.querySelector(s)
        const tx = (s) => (q(s)?.textContent ?? '').replace(/\s+/g, ' ').trim()
        return {
          thor: tx('.va-host[data-host="thor"] .va-now b'),
          thorSub: tx('.va-host[data-host="thor"] .va-now em'),
          odin: tx('.va-host[data-host="odin"] .va-now b'),
          thorNext: tx('.va-host[data-host="thor"] .va-next'),
          odinNext: tx('.va-host[data-host="odin"] .va-next'),
          thorAuto: q('.va-host[data-host="thor"] .va-host-auto')?.getAttribute('aria-checked'),
          odinAuto: q('.va-host[data-host="odin"] .va-host-auto')?.getAttribute('aria-checked'),
          thr: tx('.va-thr-value'),
          auto: q('.va-auto .va-toggle')?.getAttribute('aria-checked'),
          autoText: tx('.va-auto .va-toggle-state'),
          d: tx('.va-acct[data-acct="acct-d"] .va-acct-state'),
          dBad: q('.va-acct[data-acct="acct-d"]')?.hasAttribute('data-bad'),
          c: tx('.va-acct[data-acct="acct-c"] .va-acct-state'),
          a: tx('.va-acct[data-acct="acct-a"] .va-on'),
          aMsg: tx('.va-acct[data-acct="acct-a"] .va-acct-msg'),
          b: tx('.va-acct[data-acct="acct-b"] .va-on'),
          cOn: !!q('.va-acct[data-acct="acct-c"] .va-on'),
          resign: [...document.querySelectorAll('.va-resign')].map((b) => b.textContent.trim()),
          hist: [...document.querySelectorAll('.va-hist-row')].map((e) => ({ t: e.textContent.replace(/\s+/g, ' ').trim(), failed: e.hasAttribute('data-failed') })),
        }
      })
      const since = etClock(Date.parse(findHost(st, 'thor').lastSwitchAt))
      t.check(r.thor === 'Account A', `thor shows "${r.thor}", want Account A`)
      t.check(r.odin === 'Account B', `odin shows "${r.odin}", want Account B`)
      t.check(r.thorSub === `since ${since} · 5h 96% · week 41%`, `thor's line reads "${r.thorSub}", want "since ${since} · 5h 96% · week 41%"`)
      t.check(/Account B/.test(r.thorNext) && /5h 4% · week 20%/.test(r.thorNext), `thor's next pick reads "${r.thorNext}", want Account B with its windows`)
      t.check(/Account C/.test(r.odinNext) && /5h 30%/.test(r.odinNext), `odin's next pick reads "${r.odinNext}", want Account C with its windows`)
      t.check(r.thorAuto === 'true' && r.odinAuto === 'false', `per-host auto reads thor ${r.thorAuto}, odin ${r.odinAuto}, want on and off`)
      t.check(r.thr === '98%', `the threshold reads "${r.thr}", want 98%`)
      t.check(r.auto === 'true' && r.autoText === 'On', `auto-switch reads ${r.auto} "${r.autoText}", want on`)
      t.check(r.d === 'Sign-in expired' && r.dBad, `Account D reads "${r.d}" (flagged ${r.dBad}), want a flagged "Sign-in expired"`)
      t.check(/^Expires [A-Z][a-z]{2} \d+, \d{4}$/.test(r.c), `Account C reads "${r.c}", want "Expires <date>"`)
      t.check(r.a === 'thor' && r.b === 'odin' && !r.cOn, `the sign-in rows' host marks read "${r.a}" / "${r.b}"${r.cOn ? ' and Account C has one' : ''}, want thor on A and odin on B only`)
      t.check(r.aMsg === 'Not picked now: session at 96%', `Account A's note reads "${r.aMsg}"`)
      t.check(r.resign.length === 4 && r.resign.every((x) => x === 'Re-sign in'), `Re-sign in buttons: ${JSON.stringify(r.resign)}`)
      t.check(r.hist.length === 2, `${r.hist.length} history rows, want 2 (the config entry left out)`)
      const recent = etClock(Date.parse(st.recent[1].at))
      t.check(r.hist[0]?.t.startsWith(recent) && /thor Account C → Account A/.test(r.hist[0].t) && /session at 98% · 5h 98% → 2% · 2 panes continued/.test(r.hist[0].t),
        `the newest switch reads "${r.hist[0]?.t}", want "${recent} … thor Account C → Account A … session at 98% · 5h 98% → 2% · 2 panes continued"`)
      t.check(r.hist[1]?.t.startsWith(OLD_SWITCH_ET), `the older switch reads "${r.hist[1]?.t}", want it to start with ${OLD_SWITCH_ET} (15:03 UTC in ET)`)
      t.check(r.hist[1]?.failed && /failed: target probe 401/.test(r.hist[1].t), `the failed switch is not flagged with its error ("${r.hist[1]?.t}")`)
      const lay = await page.eval(layoutReport)
      t.check(lay.docSW <= lay.W + 1, `the page is wider than the viewport (${lay.docSW} > ${lay.W})${lay.wide.length ? `: ${lay.wide.join(', ')}` : ''}`)
      t.check(lay.areaSW <= lay.areaCW + 1, `the screen's content is wider than the screen (${lay.areaSW} > ${lay.areaCW})`)
      const usage = await page.eval(() => !!document.querySelector('.vl-page[data-active] .vc-u-top'))
      t.check(usage, 'the usage panels above the switcher are gone')
      await sleep(300)
      t.check(page.writes.length === 0, `the view sent ${page.writes.length} write(s)`)
      await page.eval(() => document.querySelector('.va')?.scrollIntoView({ block: 'start', behavior: 'instant' }))
      await sleep(200)
      await t.shot(page)
    },
  }
}

function switchTest(kind) {
  return {
    name: `accounts:switch:${kind}`,
    group: 'accounts',
    timeout: 45_000,
    async run(t) {
      const { page } = await openSwitcher(t, {
        onWrite: (w, s) => {
          if (w.method !== 'POST' || w.path !== '/api/account-switch/switch') return undefined
          if (kind === 'fail500') return { status: 500, body: { error: REFUSED } }
          if (kind === 'refused') return ok({ results: [{ host: 'thor', ok: false, error: 'thor did not answer', nudged: 0 }] })
          const h = findHost(s, w.json?.host)
          const a = findAcct(s, w.json?.account)
          s.recent.unshift({ at: iso(Date.now()), kind: 'manual', host: h.host, from: h.active?.id ?? null, to: a.id, reason: 'asked from Valkyrie', ok: true, nudged: 1 })
          h.active = { id: a.id, label: a.label }
          h.lastSwitchAt = iso(Date.now())
          return ok({ results: [{ host: h.host, ok: true, nudged: 1 }] })
        },
      })
      await switcherUp(page)
      await page.tap(`${host('thor')} .va-switch`)
      await page.waitFor(`document.querySelector('${host('thor')} .va-confirm')`, { message: 'Switch now did not open the confirm' })
      const picks = await page.eval((sel) => [...document.querySelectorAll(`${sel} .va-pick`)].map((p) => ({ t: p.textContent.trim(), on: p.getAttribute('aria-checked') })), host('thor'))
      t.check(picks.length === 2 && picks.every((p) => !/Account A|Account D/.test(p.t)), `the picks are ${JSON.stringify(picks.map((p) => p.t))}, want B and C (not the current A, not the expired D)`)
      t.check(picks.find((p) => p.on === 'true')?.t.startsWith('Account B'), `the picked account is ${JSON.stringify(picks.find((p) => p.on === 'true')?.t)}, want the next pick, Account B`)
      t.check(page.writes.length === 0, 'Switch now sent a write before Confirm')
      const want = kind === 'ok' ? 'acct-c' : 'acct-b'
      if (kind === 'ok') await page.tap({ sel: `${host('thor')} .va-pick`, text: 'Account C' })
      const goText = await page.eval(text(`${host('thor')} .va-go`))
      t.check(goText === `Confirm: Account ${want.slice(-1).toUpperCase()}`, `the confirm button reads "${goText}"`)
      const since = Date.now()
      await page.tap(`${host('thor')} .va-go`)
      const w = await waitW(page, 1)
      t.check(w.json?.host === 'thor' && w.json?.account === want && w.json?.confirm === true && Object.keys(w.json).length === 3,
        `switch sent ${w.body}, want {"host":"thor","account":"${want}","confirm":true}`)
      if (kind === 'ok') {
        await t.step('success', async () => {
          await page.waitToast(/thor switched to Account C · 1 stopped pane continued/, { since })
          await page.waitFor(`(${text(`${host('thor')} .va-now b`)}) === 'Account C'`, { message: 'thor\'s card did not move to Account C' })
          const open = await page.eval(`!!document.querySelector('${host('thor')} .va-confirm')`)
          t.check(!open, 'the confirm stayed open after the switch')
          const top = await page.eval(text('.va-hist-row'))
          t.check(/thor Account A → Account C/.test(top ?? '') && /by hand/.test(top ?? ''), `the newest history row reads "${top}"`)
          const odin = await page.eval(text(`${host('odin')} .va-now b`))
          t.check(odin === 'Account B', `odin changed to "${odin}"`)
        })
      } else {
        await t.step(kind === 'fail500' ? 'refused with 500' : 'refused inside a 200', async () => {
          await page.waitToast(kind === 'fail500' ? /Could not switch thor: 500 e2e refused this write/ : /Could not switch thor: thor did not answer/, { since })
          await sleep(600)
          const now = await page.eval(text(`${host('thor')} .va-now b`))
          t.check(now === 'Account A', `after the refusal thor shows "${now}", want Account A`)
          const open = await page.eval(`!!document.querySelector('${host('thor')} .va-confirm')`)
          t.check(open, 'the confirm closed after a refused switch')
        })
      }
      await sleep(400)
      t.check(page.writes.length === 1, `${page.writes.length} write(s) sent, want 1`)
      await t.shot(page)
    },
  }
}

function cancelTest() {
  return {
    name: 'accounts:cancel',
    group: 'accounts',
    timeout: 45_000,
    async run(t) {
      const { page } = await openSwitcher(t)
      await switcherUp(page)
      await t.step('Switch now, then Cancel', async () => {
        await page.tap(`${host('odin')} .va-switch`)
        await page.waitFor(`document.querySelector('${host('odin')} .va-confirm')`, { message: 'Switch now did not open the confirm' })
        await page.tap(`${host('odin')} .va-cancel`)
        await page.waitFor(`!document.querySelector('${host('odin')} .va-confirm') && !!document.querySelector('${host('odin')} .va-switch')`, { message: 'Cancel did not close the confirm' })
      })
      await t.step('an armed Re-sign in goes back on its own', async () => {
        await page.tap(`${acctRow('acct-c')} .va-resign`)
        const armed = await page.eval(text(`${acctRow('acct-c')} .va-resign`))
        t.check(armed === 'Start?', `one tap on Re-sign in reads "${armed}", want Start?`)
        await page.waitFor(`(${text(`${acctRow('acct-c')} .va-resign`)}) === 'Re-sign in'`, { timeout: 6000, message: 'the armed Re-sign in did not go back' })
      })
      await sleep(300)
      t.check(page.writes.length === 0, `${page.writes.length} write(s) sent, want none`)
    },
  }
}

/** POST /api/account-switch/config the way the backend merges it; answers { config }. */
function applyConfig(s, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'hosts') s.config.hosts = { ...s.config.hosts, ...v }
    else s.config[k] = v
  }
  s.enabled = s.config.enabled
  s.dryRun = s.config.dryRun
  for (const h of s.hosts) h.enabled = s.config.hosts[h.host]
  return ok({ config: s.config })
}

function autoTest(kind) {
  const fail = kind === 'fail403'
  return {
    name: `accounts:auto:${kind}`,
    group: 'accounts',
    timeout: 45_000,
    async run(t) {
      const { page } = await openSwitcher(t, {
        onWrite: (w, s) => {
          if (w.method !== 'POST' || w.path !== '/api/account-switch/config') return undefined
          if (fail) return { status: 403, body: { error: REFUSED } }
          return applyConfig(s, w.json ?? {})
        },
      })
      await switcherUp(page)
      const since = Date.now()
      await page.tap('.va-auto .va-toggle')
      const w = await waitW(page, 1)
      t.check(w.json?.enabled === false && Object.keys(w.json ?? {}).length === 1, `the toggle sent ${w.body}, want {"enabled":false}`)
      if (fail) {
        await t.step('refused with 403', async () => {
          await page.waitToast(/Auto-switch not changed: 403/, { since })
          await page.waitFor(`document.querySelector('.va-auto .va-toggle')?.getAttribute('aria-checked') === 'true'`, { message: 'the toggle did not stay on' })
        })
      } else {
        await t.step('success', async () => {
          await page.waitToast(/Auto-switch off/, { since })
          await page.waitFor(`document.querySelector('.va-auto .va-toggle')?.getAttribute('aria-checked') === 'false'`, { message: 'the toggle did not go off' })
          const note = await page.eval(text('.va-auto'))
          t.check(/Off: no automatic switch/.test(note ?? ''), `the off note is missing ("${note}")`)
          const thorAuto = await page.eval(text(`${host('thor')} .va-host-auto .va-toggle-state`))
          t.check(thorAuto === 'On (all off)', `thor's own auto reads "${thorAuto}" with auto-switch off, want "On (all off)"`)
        })
      }
      await sleep(400)
      t.check(page.writes.length === 1, `${page.writes.length} write(s) sent, want 1`)
    },
  }
}

function thresholdTest() {
  return {
    name: 'accounts:threshold',
    group: 'accounts',
    timeout: 45_000,
    async run(t) {
      const { page } = await openSwitcher(t, {
        onWrite: (w, s) => (w.method === 'POST' && w.path === '/api/account-switch/config' ? applyConfig(s, w.json ?? {}) : undefined),
      })
      await switcherUp(page)
      for (let k = 0; k < 3; k++) await page.tap('.va-thr-step[aria-label="Lower the threshold"]')
      const shown = await page.eval(text('.va-thr-value'))
      t.check(shown === '95%', `three steps down read "${shown}", want 95%`)
      t.check(page.writes.length === 0, 'a step sent a write before Save')
      const since = Date.now()
      await page.tap('.va-thr-save')
      const w = await waitW(page, 1)
      t.check(w.json?.thresholdPct === 95 && Object.keys(w.json ?? {}).length === 1, `Save sent ${w.body}, want {"thresholdPct":95}`)
      await t.step('saved', async () => {
        await page.waitToast(/Switches at 95% now/, { since })
        await page.waitFor(`!document.querySelector('.va-thr-save')`, { message: 'Save stayed after the threshold was saved' })
        const after = await page.eval(text('.va-thr-value'))
        t.check(after === '95%', `after Save the threshold reads "${after}"`)
      })
      await sleep(300)
      t.check(page.writes.length === 1, `${page.writes.length} write(s) sent, want 1`)
    },
  }
}

function hostAutoTest() {
  return {
    name: 'accounts:host-auto',
    group: 'accounts',
    timeout: 45_000,
    async run(t) {
      const { page } = await openSwitcher(t, {
        onWrite: (w, s) => (w.method === 'POST' && w.path === '/api/account-switch/config' ? applyConfig(s, w.json ?? {}) : undefined),
      })
      await switcherUp(page)
      const since = Date.now()
      await page.tap(`${host('odin')} .va-host-auto`)
      const w = await waitW(page, 1)
      t.check(w.json?.hosts?.odin === true && Object.keys(w.json.hosts).length === 1 && Object.keys(w.json).length === 1, `odin's auto sent ${w.body}, want {"hosts":{"odin":true}}`)
      await t.step('odin auto on', async () => {
        await page.waitToast(/Auto-switch on for odin/, { since })
        await page.waitFor(`document.querySelector('${host('odin')} .va-host-auto')?.getAttribute('aria-checked') === 'true'`, { message: 'odin\'s auto did not turn on' })
        const thor = await page.eval(`document.querySelector('${host('thor')} .va-host-auto')?.getAttribute('aria-checked')`)
        t.check(thor === 'true', `thor's auto changed to ${thor}`)
      })
      await sleep(300)
      t.check(page.writes.length === 1, `${page.writes.length} write(s) sent, want 1`)
    },
  }
}

function signinTest(kind) {
  return {
    name: `accounts:signin:${kind}`,
    group: 'accounts',
    timeout: 60_000,
    async run(t) {
      const live = kind === 'cancel' ? { requests: [request('e2e-req-2', 'acct-c', 'needs-code', { dmSent: true, detail: 'waiting for the pasted code' })], vault: [] } : undefined
      const { page, st, sg } = await openSwitcher(t, {
        signins: live,
        onWrite: (w, s, g) => {
          if (w.method !== 'POST') return undefined
          if (w.path === '/api/account-switch/signin') {
            if (kind === 'fail429') return { status: 429, body: { error: '3 sign-ins for this account in 24 hours already' } }
            const r = request('e2e-req-1', w.json?.accountId, 'browser', { detail: 'thor: starting' })
            g.requests.unshift(r)
            return ok({ request: r }, 202)
          }
          const m = /^\/api\/account-switch\/signin\/([^/]+)\/(code|cancel)$/.exec(w.path)
          const r = m && g.requests.find((x) => x.id === m[1])
          if (!r) return undefined
          if (m[2] === 'cancel') {
            Object.assign(r, { stage: 'canceled', needsCode: false, ok: false, updatedAt: iso(Date.now()), finishedAt: iso(Date.now()) })
            return ok({ request: r })
          }
          Object.assign(r, { stage: 'done', needsCode: false, ok: true, detail: 'token stored', updatedAt: iso(Date.now()), finishedAt: iso(Date.now()) })
          findAcct(s, r.accountId).token = { present: true, dead: false, expiresAt: iso(Date.now() + 365 * DAY) }
          return ok({ request: r })
        },
      })
      await switcherUp(page)

      if (kind === 'cancel') {
        await page.waitFor(`document.querySelector('${acctRow('acct-c')} .va-code input')`, { message: 'a waiting sign-in did not show its code box' })
        const others = await page.eval(() => [...document.querySelectorAll('.va-resign')].filter((b) => b.disabled).length)
        t.check(others === 4, `${others} Re-sign in buttons are disabled while a sign-in waits, want all 4`)
        const since = Date.now()
        await page.tap(`${acctRow('acct-c')} .va-run-cancel`)
        const w = await waitW(page, 1)
        t.check(w.path === '/api/account-switch/signin/e2e-req-2/cancel', `Cancel went to ${w.method} ${w.path}`)
        await t.step('canceled', async () => {
          await page.waitToast(/Sign-in canceled for Account C/, { since })
          await page.waitFor(`!document.querySelector('${acctRow('acct-c')} .va-code') && /Sign-in canceled/.test(${text(`${acctRow('acct-c')} .va-run`)} || '')`, { message: 'the row did not show the canceled sign-in' })
          const enabled = await page.eval(() => [...document.querySelectorAll('.va-resign')].filter((b) => !b.disabled).length)
          t.check(enabled === 4, `${enabled} Re-sign in buttons are back, want 4`)
        })
        await sleep(300)
        t.check(page.writes.length === 1, `${page.writes.length} write(s) sent, want 1`)
        return
      }

      await page.tap(`${acctRow('acct-d')} .va-resign`)
      t.check(page.writes.length === 0, 'the first tap on Re-sign in sent a write')
      const since = Date.now()
      await page.tap(`${acctRow('acct-d')} .va-resign`)
      const w = await waitW(page, 1)
      t.check(w.path === '/api/account-switch/signin' && w.json?.accountId === 'acct-d' && Object.keys(w.json ?? {}).length === 1, `Re-sign in sent ${w.method} ${w.path} ${w.body}, want {"accountId":"acct-d"}`)
      if (kind === 'fail429') {
        await t.step('refused with 429', async () => {
          await page.waitToast(/Sign-in not started for Account D: 429 3 sign-ins for this account in 24 hours already/, { since })
          const label = await page.eval(text(`${acctRow('acct-d')} .va-resign`))
          t.check(label === 'Re-sign in', `after the refusal the button reads "${label}"`)
        })
        await sleep(300)
        t.check(page.writes.length === 1, `${page.writes.length} write(s) sent, want 1`)
        return
      }
      await t.step('the steps show', async () => {
        await page.waitToast(/Signing in Account D/, { since })
        await page.waitFor(`/Signing in on thor/.test(${text(`${acctRow('acct-d')} .va-run`)} || '')`, { message: 'the sign-in step did not show' })
        const others = await page.eval(() => [...document.querySelectorAll('.va-resign')].filter((b) => b.disabled).length)
        t.check(others === 4, `${others} Re-sign in buttons are disabled during the sign-in, want all 4`)
      })
      // thor could not finish: the next 3 s read shows the code box
      Object.assign(sg.requests[0], { stage: 'needs-code', needsCode: true, dmSent: true, fallbackReason: 'bot check on the login page', updatedAt: iso(Date.now()) })
      await t.step('the code box', async () => {
        await page.waitFor(`document.querySelector('${acctRow('acct-d')} .va-code input')`, { timeout: 8000, message: 'the code box did not show for needs-code' })
        const line = await page.eval(text(`${acctRow('acct-d')} .va-run-line`))
        t.check(/Lil kups DM/.test(line ?? '') && /bot check on the login page/.test(line ?? ''), `the waiting line reads "${line}"`)
        await page.eval(setValue, `${acctRow('acct-d')} .va-code input`, 'no-hash-here')
        await page.tap(`${acctRow('acct-d')} .va-code-send`)
        await page.waitFor(`/has a # in the middle/.test(${text(`${acctRow('acct-d')} .va-run`)} || '')`, { message: 'a code without # was not refused in the page' })
        t.check(page.writes.length === 1, 'a code without # was sent')
      })
      const since2 = Date.now()
      await page.eval(setValue, `${acctRow('acct-d')} .va-code input`, CODE)
      await page.tap(`${acctRow('acct-d')} .va-code-send`)
      const w2 = await waitW(page, 2)
      t.check(w2.path === '/api/account-switch/signin/e2e-req-1/code' && w2.json?.code === CODE && Object.keys(w2.json ?? {}).length === 1,
        `the code went as ${w2.method} ${w2.path} with ${w2.json?.code === CODE ? 'the code' : 'a different code'} (${Object.keys(w2.json ?? {}).join(', ')})`)
      await t.step('signed in', async () => {
        await page.waitToast(/Code sent for Account D/, { since: since2 })
        await page.waitFor(`!document.querySelector('${acctRow('acct-d')} .va-code')`, { message: 'the code box stayed after the code was taken' })
        await page.waitFor(`!document.querySelector('${acctRow('acct-d')}').hasAttribute('data-bad')`, { message: 'Account D is still flagged after the sign-in' })
        const row = await page.eval(text(acctRow('acct-d')))
        t.check(/Signed in until/.test(row ?? '') && /Signed in: token stored/.test(row ?? ''), `Account D reads "${row}"`)
        const left = await page.eval((c) => document.body.innerHTML.includes(c), CODE)
        t.check(!left, 'the code is still in the page after it was sent')
      })
      t.check(findAcct(st, 'acct-d').token.present, 'the fake switcher lost the token')
      await sleep(300)
      t.check(page.writes.length === 2, `${page.writes.length} write(s) sent, want 2`)
      await t.shot(page)
    },
  }
}

function edgeTest() {
  return {
    name: 'accounts:edge',
    group: 'accounts',
    timeout: 45_000,
    async run(t) {
      const state = switchState({ dryRun: true })
      state.config.dryRun = true
      Object.assign(findHost(state, 'thor'), { paused: true, pausedReason: 'live file holds a /login sign-in' })
      Object.assign(findHost(state, 'odin'), { active: null, owner: 'grant', next: null, nextReason: 'no pool token', lastSwitchAt: null })
      // only Account B still works: thor can move to it; odin can too, since it is on no switcher account
      for (const a of state.accounts) if (a.id !== 'acct-b') a.token = { present: false, dead: false, expiresAt: null }
      const { page } = await openSwitcher(t, {
        state,
        onWrite: (w) => (w.method === 'POST' && w.path === '/api/account-switch/resume'
          ? { status: 409, body: { ok: false, switchedTo: null, error: 'thor is unreachable' } }
          : undefined),
      })
      await switcherUp(page)
      const r = await page.eval(() => {
        const tx = (s) => (document.querySelector(s)?.textContent ?? '').replace(/\s+/g, ' ').trim()
        return {
          dry: tx('.va-auto'),
          thor: tx('.va-host[data-host="thor"]'),
          odin: tx('.va-host[data-host="odin"]'),
          odinNow: tx('.va-host[data-host="odin"] .va-now'),
          bad: tx('.va-signins header'),
        }
      })
      t.check(/Dry run: automatic switches are only logged\. Switch now is real\./.test(r.dry), `the dry-run note is missing ("${r.dry}")`)
      t.check(/Auto-switch paused here: live file holds a \/login sign-in/.test(r.thor), `thor's pause is not shown ("${r.thor}")`)
      t.check(/Not on a switcher account/.test(r.odinNow) && /odin holds a \/login sign-in/.test(r.odinNow), `odin's /login sign-in is not explained ("${r.odinNow}")`)
      t.check(/None: no pool token/.test(r.odin), `odin's empty next pick does not give the switcher's reason ("${r.odin}")`)
      t.check(/1 working · 3 need a sign-in/.test(r.bad), `the sign-ins count reads "${r.bad}"`)
      await t.step('Switch now in dry run says it is real', async () => {
        await page.tap(`${host('thor')} .va-switch`)
        const q = await page.eval(text(`${host('thor')} .va-confirm-q`))
        t.check(/real, even in dry run/.test(q ?? ''), `the confirm reads "${q}"`)
        await page.tap(`${host('thor')} .va-cancel`)
      })
      const since = Date.now()
      await page.tap(`${host('thor')} .va-resume`)
      const w = await waitW(page, 1)
      t.check(w.json?.host === 'thor' && Object.keys(w.json ?? {}).length === 1, `Resume sent ${w.body}, want {"host":"thor"}`)
      await t.step('Resume refused with 409', async () => {
        await page.waitToast(/thor not resumed: 409 thor is unreachable/, { since })
        const still = await page.eval(text(`${host('thor')} .va-paused`))
        t.check(/paused here/.test(still ?? ''), 'the pause line went away after a refused Resume')
      })
      await sleep(300)
      t.check(page.writes.length === 1, `${page.writes.length} write(s) sent, want 1`)
      await t.shot(page)
    },
  }
}

function killTest() {
  return {
    name: 'accounts:kill',
    group: 'accounts',
    timeout: 45_000,
    async run(t) {
      const { page } = await openSwitcher(t, {
        state: switchState({ killed: true }),
        onWrite: (w, s) => {
          if (w.method !== 'POST' || w.path !== '/api/account-switch/kill') return undefined
          s.killed = w.json?.on === true
          return ok({ killed: s.killed })
        },
      })
      await switcherUp(page)
      const warn = await page.eval(text('.va-kill'))
      t.check(/Kill switch is set on odin/.test(warn ?? ''), `the kill switch is not shown ("${warn}")`)
      await page.tap('.va-unkill')
      const armed = await page.eval(text('.va-unkill'))
      t.check(armed === 'Remove it?' && page.writes.length === 0, `one tap on Remove reads "${armed}" with ${page.writes.length} write(s), want "Remove it?" and none`)
      const since = Date.now()
      await page.tap('.va-unkill')
      const w = await waitW(page, 1)
      t.check(w.json?.on === false && Object.keys(w.json ?? {}).length === 1, `Remove sent ${w.body}, want {"on":false}`)
      await t.step('removed', async () => {
        await page.waitToast(/Kill switch removed/, { since })
        await page.waitFor(`!document.querySelector('.va-kill')`, { message: 'the kill switch line stayed' })
      })
      await sleep(300)
      t.check(page.writes.length === 1, `${page.writes.length} write(s) sent, want 1`)
    },
  }
}

function missingTest() {
  return {
    name: 'accounts:missing',
    group: 'accounts',
    timeout: 45_000,
    async run(t) {
      const { page } = await openSwitcher(t, { status: () => ({ status: 404, body: { error: 'Not found' } }) })
      await page.waitFor(`/not running on odin yet/.test(${text('.va-one')} || '')`, { timeout: 12_000, message: 'the not-installed note did not show for a 404' })
      const hosts = await page.eval(`document.querySelectorAll('.va-host').length`)
      t.check(hosts === 0, `${hosts} host cards show without a switcher`)
      const usage = await page.eval(() => !!document.querySelector('.vl-page[data-active] .vc-u-top'))
      t.check(usage, 'the usage panels are gone')
      await sleep(300)
      t.check(page.writes.length === 0, `${page.writes.length} write(s) sent, want none`)
    },
  }
}

export function accountTests() {
  return [
    viewTest('phone'),
    viewTest('desktop'),
    switchTest('ok'),
    switchTest('fail500'),
    switchTest('refused'),
    cancelTest(),
    autoTest('ok'),
    autoTest('fail403'),
    thresholdTest(),
    hostAutoTest(),
    signinTest('ok'),
    signinTest('fail429'),
    signinTest('cancel'),
    edgeTest(),
    killTest(),
    missingTest(),
  ]
}
