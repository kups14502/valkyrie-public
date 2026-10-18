// Throwaway odin shell panes for the terminal tests (tests/terminal.mjs).
//
// A terminal page attaches a client to a tmux pane and resizes it to its own
// screen, so it may only ever attach to a pane the test made for itself: a
// plain shell in odin's home, labeled "v2 test", created straight on odin's
// API over ssh (the probe refuses writes) and killed again in the test's
// finally block. Never one of Brendon's sessions, and never "the latest one":
// every call here takes or returns one exact name.
//
// Every pane made here is remembered until it is killed; killLeftovers() (run
// by run.mjs at the end and on Ctrl+C) kills any a crashed test left behind.

import { execFile } from 'node:child_process'

const NAME_RE = /^vk-[0-9a-f]{10}$/
const API = 'http://127.0.0.1:3001/api/terminal/sessions'
const SSH = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'odin']
/** every pane this run made, and the ones not killed yet */
const made = new Set()
const alive = new Set()

function ssh(cmd, timeout = 20_000) {
  return new Promise((resolve, reject) => {
    execFile('ssh', [...SSH, cmd], { timeout, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(new Error(`ssh odin: ${(stderr || err.message).trim().slice(0, 300)}`))
      else resolve(stdout)
    })
  })
}

/** Creates a throwaway shell pane on odin and returns its exact name (vk-...). */
export async function openThrowawayPane() {
  const body = JSON.stringify({ mode: 'shell', host: 'odin', target: 'home', label: 'v2 test' })
  const out = await ssh(`curl -s -X POST -H 'Content-Type: application/json' -d '${body}' ${API}`)
  let name = ''
  try {
    name = JSON.parse(out)?.name ?? ''
  } catch {
    throw new Error(`odin did not open a test pane: ${out.trim().slice(0, 300)}`)
  }
  if (!NAME_RE.test(name)) throw new Error(`odin answered a pane name that is not one: ${JSON.stringify(name)} (${out.trim().slice(0, 200)})`)
  made.add(name)
  alive.add(name)
  return name
}

/** Kills one throwaway pane by its exact name (a second call is a no-op). Returns odin's answer. */
export async function killPane(name) {
  if (!NAME_RE.test(name) || !made.has(name)) throw new Error(`refusing to kill ${JSON.stringify(name)}: not a pane this run made`)
  if (!alive.has(name)) return 'already killed'
  const out = await ssh(`curl -s -X POST ${API}/${name}/kill`)
  alive.delete(name)
  return out.trim()
}

/** The names odin lists right now (a GET through the read-only probe). */
export async function listPanes(base) {
  const r = await fetch(`${base}/api/terminal/sessions`, { signal: AbortSignal.timeout(10_000) })
  if (!r.ok) throw new Error(`GET /api/terminal/sessions answered ${r.status}`)
  const d = await r.json()
  return Array.isArray(d) ? d : []
}

/** Kills every pane this run made and has not killed yet. */
export async function killLeftovers(log = console.log) {
  for (const name of [...alive]) {
    try {
      await killPane(name)
      log(`killed leftover test pane ${name}`)
    } catch (e) {
      log(`could not kill leftover test pane ${name}: ${e.message}`)
    }
  }
}
