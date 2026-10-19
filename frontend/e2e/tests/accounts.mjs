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
//   setup         Set up in plain words: how many accounts are set up, why a
//                 person has to sign in (one a year; claude.ai's captcha stops the
//                 automated browser), Set up N accounts, one account at a time with
//                 the code box in the panel, the next account, Stop setup; after a
//                 finished setup "All N set up" and Resume on a host never taken over
//   copy          Copy to thor for a token on odin only: done, and thor not answering
//   view          both hosts' accounts, per-host auto, the next picks, the threshold,
//                 auto on, sign-in states (Renew by, Token expired: sign in again),
//                 the last switches in ET (a UTC time converted, config entries left
//                 out), inside the viewport (phone, desktop)
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
// The page's rule: "3:04 PM ET" today, "Oct 17 3:04 PM ET" another day (a fixture 40 min old
// is yesterday's for the first 40 minutes after midnight).
const etDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
const etClock = (ms) => {
  const t = `${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(ms)} ET`
  return etDay.format(ms) === etDay.format(Date.now()) ? t : `${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' }).format(ms)} ${t}`
}

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
          setup: { head: tx('.va-setup .va-setup-head'), text: tx('.va-setup'), go: tx('.va-setup .va-setup-go'), note: tx('.va-setup .va-setup-note') },
          signinsNote: tx('.va-signins .va-signins-note'),
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
      t.check(r.d === 'Token expired: sign in again' && r.dBad, `Account D reads "${r.d}" (flagged ${r.dBad}), want a flagged "Token expired: sign in again"`)
      t.check(/^Renew by [A-Z][a-z]{2} \d+, \d{4}$/.test(r.c), `Account C reads "${r.c}", want "Renew by <date>" (its token ends inside 14 days)`)
      t.check(r.a === 'thor' && r.b === 'odin' && !r.cOn, `the sign-in rows' host marks read "${r.a}" / "${r.b}"${r.cOn ? ' and Account C has one' : ''}, want thor on A and odin on B only`)
      t.check(r.aMsg === 'Not picked now: session at 96%', `Account A's note reads "${r.aMsg}"`)
      t.check(JSON.stringify(r.resign) === JSON.stringify(['Renew', 'Renew', 'Renew', 'Sign in']), `the sign-in buttons read ${JSON.stringify(r.resign)}, want Renew for the three working tokens and Sign in for the expired one`)
      // Set up: what switching still needs, in plain words, and its one action
      t.check(r.setup.head === '3 of 4 accounts are set up for switching', `the Set up heading reads "${r.setup.head}"`)
      t.check(/Each account needs one sign-in a year\. Valkyrie DMs you a link for each account, one at a time/.test(r.setup.text), `Set up does not explain the yearly sign-in ("${r.setup.text.slice(0, 160)}")`)
      t.check(/Valkyrie cannot finish this alone: claude\.ai shows a captcha to the automated browser/.test(r.setup.text), 'Set up does not say why Valkyrie cannot sign in on its own')
      t.check(r.setup.go === 'Set up 1 account' && r.setup.note === '1 to sign in', `the Set up button reads "${r.setup.go}" / "${r.setup.note}"`)
      t.check(/Needs a sign-in: the switcher has no year-long token for this account yet, so it cannot switch to it\./.test(r.signinsNote), `the sign-ins list does not explain "Needs a sign-in" ("${r.signinsNote}")`)
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
      await t.step('an armed Renew goes back on its own', async () => {
        await page.tap(`${acctRow('acct-c')} .va-resign`)
        const armed = await page.eval(text(`${acctRow('acct-c')} .va-resign`))
        t.check(armed === 'Renew?', `one tap on Renew reads "${armed}", want Renew? (a working token is replaced only on a second tap)`)
        await page.waitFor(`(${text(`${acctRow('acct-c')} .va-resign`)}) === 'Renew'`, { timeout: 6000, message: 'the armed Renew did not go back' })
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
          Object.assign(r, { stage: 'done', needsCode: false, ok: true, detail: 'token stored', vault: { odin: true, thor: true }, updatedAt: iso(Date.now()), finishedAt: iso(Date.now()) })
          findAcct(s, r.accountId).token = { present: true, dead: false, expiresAt: iso(Date.now() + 365 * DAY) }
          return ok({ request: r })
        },
      })
      await switcherUp(page)

      if (kind === 'cancel') {
        await page.waitFor(`document.querySelector('${acctRow('acct-c')} .va-code input')`, { message: 'a waiting sign-in did not show its code box' })
        const others = await page.eval(() => [...document.querySelectorAll('.va-resign')].filter((b) => b.disabled).length)
        t.check(others === 4, `${others} sign-in buttons are disabled while a sign-in waits, want all 4`)
        const setupNote = await page.eval(text('.va-setup .va-setup-note'))
        t.check(setupNote === 'Finish the sign-in below first.', `Set up's note reads "${setupNote}" while a sign-in waits`)
        const since = Date.now()
        await page.tap(`${acctRow('acct-c')} [aria-label="Cancel the sign-in for Account C"]`)
        const w = await waitW(page, 1)
        t.check(w.path === '/api/account-switch/signin/e2e-req-2/cancel', `Cancel went to ${w.method} ${w.path}`)
        await t.step('canceled', async () => {
          await page.waitToast(/Sign-in canceled for Account C/, { since })
          await page.waitFor(`!document.querySelector('${acctRow('acct-c')} .va-code') && /Canceled/.test(${text(`${acctRow('acct-c')} .va-run`)} || '')`, { message: 'the row did not show the canceled sign-in' })
          const enabled = await page.eval(() => [...document.querySelectorAll('.va-resign')].filter((b) => !b.disabled).length)
          t.check(enabled === 4, `${enabled} sign-in buttons are back, want 4`)
        })
        await sleep(300)
        t.check(page.writes.length === 1, `${page.writes.length} write(s) sent, want 1`)
        return
      }

      // an account with no working token needs one tap (Sign in); a working one asks twice (Renew, see cancel)
      const label0 = await page.eval(text(`${acctRow('acct-d')} .va-resign`))
      t.check(label0 === 'Sign in', `the expired account's button reads "${label0}", want Sign in`)
      const since = Date.now()
      await page.tap(`${acctRow('acct-d')} .va-resign`)
      const w = await waitW(page, 1)
      t.check(w.path === '/api/account-switch/signin' && w.json?.accountId === 'acct-d' && Object.keys(w.json ?? {}).length === 1, `Sign in sent ${w.method} ${w.path} ${w.body}, want {"accountId":"acct-d"}`)
      if (kind === 'fail429') {
        await t.step('refused with 429', async () => {
          await page.waitToast(/Sign-in not started for Account D: 429 3 sign-ins for this account in 24 hours already/, { since })
          const label = await page.eval(text(`${acctRow('acct-d')} .va-resign`))
          t.check(label === 'Sign in', `after the refusal the button reads "${label}"`)
        })
        await sleep(300)
        t.check(page.writes.length === 1, `${page.writes.length} write(s) sent, want 1`)
        return
      }
      await t.step('the steps show', async () => {
        await page.waitToast(/Sign-in link for Account D is on its way in Lil kups/, { since })
        await page.waitFor(`/Signing in on thor/.test(${text(`${acctRow('acct-d')} .va-run`)} || '')`, { message: 'the sign-in step did not show' })
        const others = await page.eval(() => [...document.querySelectorAll('.va-resign')].filter((b) => b.disabled).length)
        t.check(others === 4, `${others} sign-in buttons are disabled during the sign-in, want all 4`)
      })
      // thor could not finish: the next 3 s read shows the code box
      const until = Date.now() + 60 * MIN
      Object.assign(sg.requests[0], { stage: 'needs-code', needsCode: true, dmSent: true, dmAt: iso(Date.now()), waitUntil: iso(until), fallbackReason: 'bot check on the login page', updatedAt: iso(Date.now()) })
      await t.step('the code box', async () => {
        await page.waitFor(`document.querySelector('${acctRow('acct-d')} .va-code input')`, { timeout: 8000, message: 'the code box did not show for needs-code' })
        const line = await page.eval(text(`${acctRow('acct-d')} .va-run-line`))
        t.check(line === `Waiting for your code until ${etClock(until)}`, `the waiting line reads "${line}", want "Waiting for your code until ${etClock(until)}"`)
        const steps = await page.eval(text(`${acctRow('acct-d')} .va-steps`))
        t.check(/Open the link in the Lil kups DM in a private window/.test(steps ?? '') && /Sign in as d@example\.invalid and press Authorize/.test(steps ?? ''), `the steps read "${steps}"`)
        const dm = await page.eval(() => [...document.querySelectorAll('.va-acct[data-acct="acct-d"] .va-body-act .vl-link')].map((b) => ({ t: b.textContent.trim(), off: b.disabled })))
        t.check(dm.some((b) => b.t === 'DM sent' && b.off), `a DM sent a moment ago still offers to send it again: ${JSON.stringify(dm)}`)
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
        t.check(/Set up until/.test(row ?? '') && /Set up: token saved on odin and thor/.test(row ?? ''), `Account D reads "${row}"`)
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
          setup: tx('.va-setup .va-setup-head'),
          setupGo: tx('.va-setup .va-setup-go'),
          setupNote: tx('.va-setup .va-setup-note'),
        }
      })
      t.check(/Dry run: automatic switches are only logged\. Switch now is real\./.test(r.dry), `the dry-run note is missing ("${r.dry}")`)
      t.check(/Auto-switch paused here: live file holds a \/login sign-in/.test(r.thor), `thor's pause is not shown ("${r.thor}")`)
      // "not on a switcher account" was a riddle: the card now says whose sign-in it is and what Resume does
      t.check(/^Its own sign-in/.test(r.odinNow) && /odin still uses its normal \/login sign-in, so the switcher has not taken over\. Resume hands odin to the switcher\./.test(r.odinNow), `odin's /login sign-in is not explained ("${r.odinNow}")`)
      t.check(!/Not on a switcher account/i.test(r.odin), 'odin still says "Not on a switcher account"')
      t.check(/None: no account is set up yet/.test(r.odin), `odin's empty next pick does not say why in plain words ("${r.odin}")`)
      t.check(/1 of 4 set up/.test(r.bad), `the sign-ins count reads "${r.bad}"`)
      t.check(r.setup === '1 of 4 accounts are set up for switching' && r.setupGo === 'Set up 3 accounts' && r.setupNote === '3 to sign in', `Set up reads "${r.setup}" / "${r.setupGo}" / "${r.setupNote}"`)
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

// ---------- Set up: one sign-in per account per year, one at a time ----------

/** The status with A set up on both hosts, B on odin only, C never signed in, D expired. */
function setupState() {
  const s = switchState()
  findAcct(s, 'acct-a').onThor = true
  findAcct(s, 'acct-b').onThor = false
  findAcct(s, 'acct-c').token = { present: false, dead: false, expiresAt: null }
  findAcct(s, 'acct-c').onThor = false
  findAcct(s, 'acct-d').onThor = false
  return s
}

function queueOf(items, over = {}) {
  const now = iso(Date.now())
  return { id: 'e2e-q1', state: 'running', reason: null, already: 1, items, startedAt: now, updatedAt: now, finishedAt: null, ...over }
}
const qItem = (accountId, kind, status, requestId = null) => ({ accountId, label: `Account ${accountId.slice(-1).toUpperCase()}`, kind, status, detail: null, requestId })

function setupRunTest() {
  return {
    name: 'accounts:setup:run',
    group: 'accounts',
    timeout: 60_000,
    async run(t) {
      const until = Date.now() + 60 * MIN
      const { page, st } = await openSwitcher(t, {
        state: setupState(),
        signins: { requests: [], vault: [], queue: null, plan: { signin: ['acct-c', 'acct-d'], copy: ['acct-b'], already: 1 } },
        onWrite: (w, s, g) => {
          if (w.method !== 'POST') return undefined
          if (w.path === '/api/account-switch/signin/queue') {
            g.queue = queueOf([qItem('acct-c', 'signin', 'running', 'e2e-req-q1'), qItem('acct-d', 'signin', 'waiting'), qItem('acct-b', 'copy', 'waiting')])
            g.requests.unshift(request('e2e-req-q1', 'acct-c', 'needs-code', { dmSent: true, dmAt: iso(Date.now()), waitUntil: iso(until), queue: { n: 1, of: 2 } }))
            return ok({ queue: g.queue }, 202)
          }
          if (w.path === '/api/account-switch/signin/e2e-req-q1/code') {
            Object.assign(g.requests[0], { stage: 'done', needsCode: false, ok: true, vault: { odin: true, thor: true }, updatedAt: iso(Date.now()), finishedAt: iso(Date.now()) })
            Object.assign(findAcct(s, 'acct-c'), { token: { present: true, dead: false, expiresAt: iso(Date.now() + 365 * DAY) }, onThor: true })
            g.queue.items[0].status = 'done'
            g.queue.items[1] = { ...g.queue.items[1], status: 'running', requestId: 'e2e-req-q2' }
            g.requests.unshift(request('e2e-req-q2', 'acct-d', 'needs-code', { dmSent: true, dmAt: iso(Date.now()), waitUntil: iso(until), queue: { n: 2, of: 2 } }))
            g.plan = { signin: ['acct-d'], copy: ['acct-b'], already: 2 }
            return ok({ request: g.requests[1] })
          }
          if (w.path === '/api/account-switch/signin/queue/cancel') {
            Object.assign(g.queue, { state: 'canceled', reason: 'stopped by hand', finishedAt: iso(Date.now()) })
            g.queue.items[1].status = 'failed'
            Object.assign(g.requests[0], { stage: 'canceled', needsCode: false, ok: false, updatedAt: iso(Date.now()), finishedAt: iso(Date.now()) })
            return ok({ queue: g.queue })
          }
          return undefined
        },
      })
      await switcherUp(page)
      const before = await page.eval(() => {
        const tx = (s) => (document.querySelector(s)?.textContent ?? '').replace(/\s+/g, ' ').trim()
        return { head: tx('.va-setup .va-setup-head'), go: tx('.va-setup .va-setup-go'), note: tx('.va-setup .va-setup-note'), b: tx('.va-acct[data-acct="acct-b"] .va-acct-state'), copy: !!document.querySelector('.va-acct[data-acct="acct-b"] .va-copy') }
      })
      t.check(before.head === '2 of 4 accounts are set up for switching', `the Set up heading reads "${before.head}"`)
      t.check(before.go === 'Set up 3 accounts' && before.note === '2 to sign in · 1 to copy to thor', `the Set up button reads "${before.go}" / "${before.note}"`)
      t.check(/· odin only$/.test(before.b) && before.copy, `Account B (on odin only) reads "${before.b}"${before.copy ? '' : ' with no Copy to thor'}`)

      const since = Date.now()
      await page.tap('.va-setup .va-setup-go')
      const w = await waitW(page, 1)
      t.check(w.path === '/api/account-switch/signin/queue' && JSON.stringify(w.json ?? {}) === '{}', `Set up sent ${w.method} ${w.path} ${w.body}`)
      await t.step('running: one account at a time, the code box in Set up', async () => {
        await page.waitToast(/Setup started: watch for the Lil kups DM/, { since })
        await page.waitFor(() => document.querySelector('.va-setup .va-q-item[data-status="running"] .va-code input'), { timeout: 8000, message: 'Set up did not show the code box for the running account' })
        const r = await page.eval(() => ({
          items: [...document.querySelectorAll('.va-setup .va-q-item')].map((li) => `${li.querySelector('.va-q-name')?.textContent?.trim()}: ${li.querySelector('.va-q-state')?.textContent?.trim()}`),
          sub: document.querySelector('.va-setup .va-sub')?.textContent?.trim() ?? '',
          rowBox: !!document.querySelector('.va-acct[data-acct="acct-c"] .va-code'),
          disabled: [...document.querySelectorAll('.va-resign')].filter((b) => b.disabled).length,
          stop: !!document.querySelector('.va-setup .va-setup-stop'),
        }))
        t.check(r.sub === 'running', `Set up's header says "${r.sub}", want running`)
        t.check(JSON.stringify(r.items) === JSON.stringify([`Account C: Waiting for your code until ${etClock(until)}`, 'Account D: Next', 'Account B: Copy to thor next']), `the setup rows read ${JSON.stringify(r.items)}`)
        t.check(!r.rowBox, 'the account row shows a second code box beside the one in Set up')
        t.check(r.disabled === 4, `${r.disabled} sign-in buttons are disabled while setup runs, want 4`)
        t.check(r.stop, 'no Stop setup while it runs')
      })
      const since2 = Date.now()
      await page.eval(setValue, '.va-setup .va-code input', CODE)
      await page.tap('.va-setup .va-code-send')
      const w2 = await waitW(page, 2)
      t.check(w2.path === '/api/account-switch/signin/e2e-req-q1/code' && w2.json?.code === CODE, `the code went as ${w2.method} ${w2.path}`)
      await t.step('the next account', async () => {
        await page.waitToast(/Code sent for Account C/, { since: since2 })
        await page.waitFor(() => /Account C: Set up/.test([...document.querySelectorAll('.va-setup .va-q-item')].map((li) => `${li.querySelector('.va-q-name')?.textContent?.trim()}: ${li.querySelector('.va-q-state')?.textContent?.trim()}`).join('|')), { timeout: 8000, message: 'Account C did not show Set up in the setup rows' })
        await page.waitFor(() => document.querySelector('.va-setup .va-q-item[data-status="running"] .va-q-name')?.textContent?.trim() === 'Account D', { timeout: 8000, message: 'Set up did not move on to Account D' })
      })
      const since3 = Date.now()
      await page.tap('.va-setup .va-setup-stop')
      const w3 = await waitW(page, 3)
      t.check(w3.path === '/api/account-switch/signin/queue/cancel', `Stop setup sent ${w3.method} ${w3.path}`)
      await t.step('stopped', async () => {
        await page.waitToast(/Setup stopped/, { since: since3 })
        await page.waitFor(() => !document.querySelector('.va-setup .va-setup-stop') && /Set up 2 accounts/.test(document.querySelector('.va-setup .va-setup-go')?.textContent ?? ''), { timeout: 8000, message: 'after Stop setup the button did not come back as "Set up 2 accounts"' })
      })
      t.check(findAcct(st, 'acct-c').token.present, 'the fake switcher lost the new token')
      await sleep(300)
      t.check(page.writes.length === 3, `${page.writes.length} write(s) sent, want 3`)
      await t.shot(page)
    },
  }
}

function setupDoneTest() {
  return {
    name: 'accounts:setup:done',
    group: 'accounts',
    timeout: 45_000,
    async run(t) {
      const s = switchState()
      for (const a of s.accounts) Object.assign(a, { onThor: true, token: { present: true, dead: false, expiresAt: iso(Date.now() + 300 * DAY) } })
      Object.assign(findHost(s, 'thor'), { active: null, owner: 'grant', adopted: false, paused: true, pausedReason: 'not adopted yet: thor still uses its own sign-in' })
      const done = iso(Date.now() - 2 * MIN)
      const { page } = await openSwitcher(t, {
        state: s,
        signins: { requests: [], vault: [], queue: queueOf(['acct-a', 'acct-b', 'acct-c', 'acct-d'].map((id) => qItem(id, 'signin', 'done')), { state: 'finished', finishedAt: done, updatedAt: done }), plan: { signin: [], copy: [], already: 4 } },
        onWrite: (w) => (w.method === 'POST' && w.path === '/api/account-switch/resume' ? ok({ ok: true, switchedTo: 'acct-b' }) : undefined),
      })
      await page.waitFor(text('.va-setup .va-setup-head'), { timeout: 12_000, message: 'Set up did not show after a finished setup' })
      const r = await page.eval(() => {
        const tx = (s) => (document.querySelector(s)?.textContent ?? '').replace(/\s+/g, ' ').trim()
        return {
          head: tx('.va-setup .va-setup-head'), text: tx('.va-setup'), go: !!document.querySelector('.va-setup .va-setup-go'),
          thor: tx('.va-host[data-host="thor"]'), take: tx('.va-host[data-host="thor"] .va-take'),
          lit: document.querySelector('.va-host[data-host="thor"] .va-take .va-resume')?.hasAttribute('data-lit') ?? false,
        }
      })
      t.check(r.head === 'All 4 accounts are set up for switching', `the Set up heading reads "${r.head}"`)
      t.check(/Next: press Resume on thor below, so its terminals use these accounts and switch when one runs low\./.test(r.text), `Set up does not say what to do next ("${r.text.slice(0, 200)}")`)
      t.check(!r.go, 'a finished setup still offers its button')
      t.check(/Takes thor over with the account that has the most room\./.test(r.take) && r.lit, `thor's card does not offer a lit Resume to take it over ("${r.take}")`)
      t.check(!/Auto-switch paused here/.test(r.thor), 'a host never taken over reads as "paused"')
      const since = Date.now()
      await page.tap('.va-host[data-host="thor"] .va-take .va-resume')
      const w = await waitW(page, 1)
      t.check(w.json?.host === 'thor' && Object.keys(w.json ?? {}).length === 1, `Resume sent ${w.body}`)
      await page.waitToast(/thor now uses Account B/, { since })
      await t.shot(page)
    },
  }
}

function copyTest(kind) {
  return {
    name: `accounts:copy:${kind}`,
    group: 'accounts',
    timeout: 45_000,
    async run(t) {
      const { page } = await openSwitcher(t, {
        state: setupState(),
        signins: { requests: [], vault: [], queue: null, plan: { signin: ['acct-c', 'acct-d'], copy: ['acct-b'], already: 1 } },
        onWrite: (w, s) => {
          if (w.method !== 'POST' || w.path !== '/api/account-switch/signin/sync-thor') return undefined
          if (kind === 'ok') findAcct(s, w.json?.accountId).onThor = true
          return ok({ ok: kind === 'ok' })
        },
      })
      await switcherUp(page)
      const since = Date.now()
      await page.tap(`${acctRow('acct-b')} .va-copy`)
      const w = await waitW(page, 1)
      t.check(w.json?.accountId === 'acct-b' && Object.keys(w.json ?? {}).length === 1, `Copy to thor sent ${w.body}`)
      if (kind === 'ok') {
        await page.waitToast(/Account B copied to thor/, { since })
        await page.waitFor(`!document.querySelector('${acctRow('acct-b')} .va-copy')`, { message: 'Copy to thor stayed after the copy' })
      } else {
        await page.waitToast(/thor did not answer; Account B is still on odin only/, { since })
        t.check(await page.eval(`!!document.querySelector('${acctRow('acct-b')} .va-copy')`), 'Copy to thor went away although thor did not answer')
      }
    },
  }
}

// ---------- AI > Usage headline and the ACCOUNTS list (emails + copy) ----------

/** GET /api/ai-usage: five accounts, the hottest is Account A, so "thor is on" must beat it. */
function aiUsage() {
  const now = Date.now()
  const q = (s, w) => ({ sessionPct: s, weeklyPct: w, sessionResetsAt: iso(now + 50 * MIN), weeklyResetsAt: iso(now + 3 * DAY), status: 'allowed' })
  const client = (id, letter, s, w, dead = false) => ({
    id, kind: 'claude', label: `Account ${letter}`, email: `${letter.toLowerCase()}@example.invalid`, subscription: 'team',
    byModel: {}, session: null, today: { tokens: 0, costUSD: 0, messages: 0 }, last7d: { tokens: 0, costUSD: 0, messages: 0 }, last30d: { tokens: 0, costUSD: 0, messages: 0 },
    quota: dead ? null : q(s, w), authError: dead ? 'stored sign-in is dead' : null,
  })
  const clients = [client('acct-a', 'A', 96, 41), client('acct-b', 'B', 12, 40), client('acct-c', 'C', 30, 60), client('acct-d', 'D', 0, 0, true)]
  return { claude: { byModel: {}, session: null, quota: clients[0].quota, today: { tokens: 0, costUSD: 0, messages: 0 }, last7d: { tokens: 0, costUSD: 0, messages: 0 }, last30d: { tokens: 0, costUSD: 0, messages: 0 } }, aiClients: clients, updatedAt: iso(now) }
}

const stubClipboard = `(() => { window.__copied = []; try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__copied.push(t); }, readText: async () => '' } }); } catch (e) {} })()`

/** The usage headline names the account thor is on (not the hottest), and every account row carries
 *  its email with a working copy button. */
function onAccountTest() {
  return {
    name: 'accounts:on-account',
    group: 'accounts',
    device: 'desktop',
    timeout: 45_000,
    async run(t) {
      const page = await t.page()
      // thor is on Account B (adopted); the hottest account is A
      const st = switchState()
      const thor = findHost(st, 'thor')
      thor.active = { id: 'acct-b', label: 'Account B' }
      thor.adopted = true
      page.mock('/api/ai-usage', () => ok(aiUsage()))
      page.mock('/api/account-switch', () => ok(st))
      page.mock('/api/account-switch/signin', () => ok({ requests: [], vault: [] }))
      await page.goto(ROUTE)
      await shellUp(page)
      await page.waitFor(() => document.querySelector('.vc-u-top .vc-acct')?.textContent, { timeout: 12_000, message: 'the usage headline never showed an account' })
      await page.eval(stubClipboard)
      const r = await page.eval(() => {
        const tx = (s) => (document.querySelector(s)?.textContent ?? '').replace(/\s+/g, ' ').trim()
        const rows = [...document.querySelectorAll('.vc-u-accts .vc-u-row:not(.vc-u-cols)')].map((row) => ({
          name: (row.querySelector('.vc-u-name > .vl-ellipsis')?.textContent ?? '').trim(),
          email: (row.querySelector('.vc-u-email > span')?.textContent ?? '').trim(),
          hasCopy: !!row.querySelector('.vc-u-copy'),
          top: row.hasAttribute('data-top'),
        }))
        return { headLabel: tx('.vc-u-top .vc-acct'), headRole: tx('.vc-u-top .vc-u-label'), big: [...document.querySelectorAll('.vc-u-top .vc-u-meter > b')].map((b) => b.textContent.replace(/\s+/g, '')), rows }
      })
      t.check(/Account B/.test(r.headLabel) && !/busiest/i.test(r.headLabel), `the headline reads "${r.headLabel}", want Account B (thor's account, not the hottest A)`)
      t.check(/thor is on/i.test(r.headRole), `the headline label reads "${r.headRole}", want "thor is on"`)
      t.check(r.big[0] === '12%' && r.big[1] === '40%', `the headline meters read ${JSON.stringify(r.big)}, want Account B's 12% and 40%`)
      const top = r.rows.find((x) => x.top)
      t.check(top?.name === 'Account B', `the active row is "${top?.name}", want Account B marked data-top`)
      t.check(r.rows.length === 4, `${r.rows.length} account rows, want 4`)
      t.check(r.rows.every((x) => x.email && x.hasCopy), `an account row is missing its email or copy button: ${JSON.stringify(r.rows)}`)
      t.check(r.rows.find((x) => x.name === 'Account A')?.email === 'a@example.invalid', `Account A's email reads "${r.rows.find((x) => x.name === 'Account A')?.email}"`)
      // copy the first account's email
      const since = Date.now()
      await page.tap({ sel: '.vc-u-accts .vc-u-copy', index: 0 })
      await page.waitFor(() => (window.__copied ?? []).length > 0, { message: 'the copy button copied nothing' })
      const copied = await page.eval(() => window.__copied[0])
      t.check(/@example\.invalid$/.test(copied), `the copy button copied "${copied}", want an email`)
      await page.waitToast(new RegExp(`Copied ${copied.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), { since })
      await sleep(300)
      t.check(page.writes.length === 0, `the usage view sent ${page.writes.length} write(s)`)
      await t.shot(page)
    },
  }
}

/** When the switcher is not deployed (404), the headline falls back to the hottest account and says so. */
function hottestFallbackTest() {
  return {
    name: 'accounts:on-account:fallback',
    group: 'accounts',
    device: 'desktop',
    timeout: 45_000,
    async run(t) {
      const page = await t.page()
      page.mock('/api/ai-usage', () => ok(aiUsage()))
      page.mock('/api/account-switch', () => ({ status: 404, body: { error: 'Not found' } }))
      page.mock('/api/account-switch/signin', () => ({ status: 404, body: { error: 'Not found' } }))
      await page.goto(ROUTE)
      await shellUp(page)
      await page.waitFor(() => document.querySelector('.vc-u-top .vc-acct')?.textContent, { timeout: 12_000, message: 'the usage headline never showed an account' })
      const r = await page.eval(() => {
        const tx = (s) => (document.querySelector(s)?.textContent ?? '').replace(/\s+/g, ' ').trim()
        return { headLabel: tx('.vc-u-top .vc-acct'), headRole: tx('.vc-u-top .vc-u-label'), big: [...document.querySelectorAll('.vc-u-top .vc-u-meter > b')].map((b) => b.textContent.replace(/\s+/g, '')) }
      })
      t.check(/Account A/.test(r.headLabel) && /busiest/i.test(r.headLabel), `the fallback headline reads "${r.headLabel}", want Account A with "busiest"`)
      t.check(r.headRole === 'Usage', `the fallback headline label reads "${r.headRole}", want "Usage"`)
      t.check(r.big[0] === '96%' && r.big[1] === '41%', `the fallback meters read ${JSON.stringify(r.big)}, want the hottest account A's 96% and 41%`)
      await sleep(200)
      t.check(page.writes.length === 0, `the fallback view sent ${page.writes.length} write(s)`)
    },
  }
}

export function accountTests() {
  return [
    onAccountTest(),
    hottestFallbackTest(),
    setupRunTest(),
    setupDoneTest(),
    copyTest('ok'),
    copyTest('thor-down'),
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
