#!/usr/bin/env node
// Valkyrie v2 (/m/*) end-to-end suite. Rerun before every ship.
//
//   node e2e/run.mjs [--base http://127.0.0.1:5197] [--only name[,name]] [--shots dir]
//                    [--concurrency 3] [--list] [--force]
//
// Drives the shared headless Edge on 127.0.0.1:9333 (e2e/browser.ps1 starts it
// on a private desktop when it is down; nothing ever opens a visible window).
// Each test gets its own browser context. Reads go to --base (the read-only
// probe by default); every write is answered inside the browser by CDP Fetch
// interception, so nothing a test taps can reach odin, and the in-page
// terminal is never loaded. See e2e/README.md.
//
// Prints a pass/fail table, writes e2e/report.json, exits 1 on any failure.

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Browser, sleep } from './lib/cdp.mjs'
import { runAll } from './lib/harness.mjs'
import { routeTests } from './tests/routes.mjs'
import { navigationTests } from './tests/navigation.mjs'
import { writeTests } from './tests/writes.mjs'
import { freshnessTests } from './tests/freshness.mjs'
import { schemeTests } from './tests/schemes.mjs'
import { uploadTests } from './tests/upload.mjs'
import { terminalTests } from './tests/terminal.mjs'
import { gapTests } from './tests/gaps.mjs'
import { accountTests } from './tests/accounts.mjs'
import { desktopTests } from './tests/desktop.mjs'
import { parityTests } from './tests/parity.mjs'
import { killLeftovers } from './lib/odin.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const argv = process.argv.slice(2)
const opt = { base: 'http://127.0.0.1:5197', only: '', shots: '', concurrency: '3', list: false, force: false, gameWait: '30' }
for (let i = 0; i < argv.length; i++) {
  const k = argv[i].replace(/^--/, '')
  if (k === 'list' || k === 'force') opt[k] = true
  else if (k === 'game-wait') opt.gameWait = argv[++i]
  else if (k in opt) opt[k] = argv[++i]
  else if (k === 'help' || k === 'h') {
    console.log('node e2e/run.mjs [--base url] [--only name[,name]] [--shots dir] [--concurrency n] [--list] [--force]')
    process.exit(0)
  } else {
    console.error(`unknown option ${argv[i]}`)
    process.exit(2)
  }
}

// ---------- the tests ----------

const all = [...freshnessTests(), ...terminalTests(), ...routeTests(), ...navigationTests(), ...writeTests(), ...uploadTests(), ...gapTests(), ...desktopTests(), ...parityTests(), ...accountTests(), ...schemeTests()]
const wanted = opt.only ? opt.only.split(',').map((s) => s.trim()).filter(Boolean) : []
const tests = wanted.length ? all.filter((t) => wanted.some((w) => t.name.includes(w) || t.group === w)) : all

if (opt.list) {
  for (const t of all) console.log(`${t.group.padEnd(10)} ${t.name}`)
  process.exit(0)
}
if (!tests.length) {
  console.error(`no test matches --only ${opt.only} (try --list)`)
  process.exit(2)
}

// ---------- Brendon may be gaming: wait while a game runs ----------

const GAMES = ['deadlock.exe', 'vrserver.exe', ...(process.env.E2E_GAMES ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)]

function gameRunning() {
  if (process.platform !== 'win32') return null
  try {
    const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
    const names = new Set(out.split(/\r?\n/).map((l) => l.split('","')[0].replace(/^"/, '').toLowerCase()))
    return GAMES.find((g) => names.has(g)) ?? null
  } catch {
    return null
  }
}

let lastGameCheck = 0
async function waitForGame() {
  if (opt.force || Date.now() - lastGameCheck < 20_000) return
  lastGameCheck = Date.now()
  let g = gameRunning()
  if (!g) return
  const until = Date.now() + Number(opt.gameWait) * 60_000
  console.log(`${g} is running: pausing the suite until it exits (up to ${opt.gameWait} min, --force skips this)`)
  while (g && Date.now() < until) {
    await sleep(30_000)
    g = gameRunning()
  }
  if (g) {
    console.error(`${g} is still running after ${opt.gameWait} min: stopping`)
    process.exit(4)
  }
  console.log('game closed, going on')
}

// ---------- the probe: reads only ----------

// Told apart by address only: probing it with a write method would send that
// write to a live backend whenever --base is one. The in-browser answer to
// every write is what keeps odin safe either way.
const probeCheck = (base) => /^https?:\/\/(127\.0\.0\.1|localhost):5197$/.test(base)

async function main() {
  const base = opt.base.replace(/\/+$/, '')
  try {
    const r = await fetch(`${base}/m/dashboard`, { signal: AbortSignal.timeout(8000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
  } catch (e) {
    console.error(`${base} is not answering (${e.message}). Start the probe: npx vite --config vite.v2probe.config.ts`)
    process.exit(3)
  }
  const probe = probeCheck(base)
  console.log(probe
    ? `base ${base}: the read-only probe (refuses every write)`
    : `base ${base}: NOT the read-only probe. Reads go to it; writes are still answered in the browser and never sent.`)
  // the real trade status, read once (a GET), for the tests that bend it
  let trade = null
  try {
    trade = await (await fetch(`${base}/api/tradebot/status`, { signal: AbortSignal.timeout(10_000) })).json()
  } catch { /* the tests fall back to a made-up status */ }

  await waitForGame()
  const browser = await Browser.connect((m) => console.log(m))
  console.log(`browser ${browser.version} on :9333 (private desktop), ${tests.length} test(s), ${opt.concurrency} at a time`)
  const shots = opt.shots ? resolve(opt.shots) : ''
  if (shots) mkdirSync(shots, { recursive: true })
  const env = { browser, base, shots, trade }
  const t0 = Date.now()
  let done = 0
  const results = await runAll(tests, env, {
    concurrency: Number(opt.concurrency) || 3,
    gate: waitForGame,
    onDone: (r) => {
      done++
      const mark = r.status === 'pass' ? 'pass' : 'FAIL'
      console.log(`[${String(done).padStart(3)}/${tests.length}] ${mark} ${r.name} (${(r.ms / 1000).toFixed(1)} s)${r.status === 'fail' ? `\n        ${r.fails.slice(0, 6).join('\n        ')}` : ''}`)
    },
  })
  browser.close()
  // a terminal test that timed out may still hold its throwaway pane
  await killLeftovers((m) => console.log(m))

  // ---------- the table and the report ----------
  const failed = results.filter((r) => r.status === 'fail')
  const w = Math.max(...results.map((r) => r.name.length), 10)
  console.log('')
  console.log(`${'test'.padEnd(w)}  result  time`)
  console.log(`${'-'.repeat(w)}  ------  ------`)
  for (const r of results) console.log(`${r.name.padEnd(w)}  ${r.status === 'pass' ? 'pass  ' : 'FAIL  '}  ${(r.ms / 1000).toFixed(1).padStart(5)}s`)
  console.log('')
  const secs = Math.round((Date.now() - t0) / 1000)
  console.log(`${results.length - failed.length} passed, ${failed.length} failed, ${Math.floor(secs / 60)}m ${secs % 60}s`)
  if (failed.length) {
    console.log('\nFailures:')
    for (const r of failed) {
      console.log(`  ${r.name}`)
      for (const f of r.fails.slice(0, 12)) console.log(`    - ${f}`)
    }
  }
  const report = {
    at: new Date().toISOString(),
    base, probe, browser: browser.version, seconds: secs,
    passed: results.length - failed.length, failed: failed.length,
    results,
  }
  const out = resolve(HERE, 'report.json')
  writeFileSync(out, JSON.stringify(report, null, 2))
  console.log(`\nreport: ${out}`)
  process.exit(failed.length ? 1 : 0)
}

// Ctrl+C: no throwaway odin pane outlives the run
process.on('SIGINT', () => {
  console.log('interrupted: killing any throwaway test pane first')
  void killLeftovers((m) => console.log(m)).finally(() => process.exit(130))
})

main().catch(async (e) => {
  console.error('the suite itself failed:', e.stack ?? e.message)
  await killLeftovers((m) => console.log(m))
  process.exit(3)
})
