import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { ProjError } from './projectTypes.js'

const exec = promisify(execFile)

// Project reminders ride on Lil' kups, the Discord DM bot that already sends
// every other odin alert. Its CLI owns the reminder list: `remind add` appends
// under a flock and prints the new id first, and the minute timer's run-due
// marks records sent or failed and prunes them 30 days after their time.
//
// The list file is read here and never written. run-due rewrites it every
// minute under that lock, so a write from this process would race it and could
// drop a reminder that was just added.

export const LILKUPS_BIN = process.env.LILKUPS_BIN || '/home/brendon/lilkups/lilkups'
export const LILKUPS_STORE = process.env.LILKUPS_STORE || path.join(homedir(), '.config/lilkups/reminders.json')

const LILKUPS_ID_RE = /^[0-9a-f]{8}$/
// An explicit offset is required. lilkups reads a naive time in the box's own
// zone, which is America/New_York, so "09:00" from a session that thinks in UTC
// would fire four or five hours off with nothing to say it went wrong.
const AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/
const MIN_LEAD_MS = 60_000
const MAX_DAYS = 366

// No worked example with a fixed offset: New York's changes twice a year, and a
// model copies an example's offset onto whatever date it is given.
export const OFFSET_RULE = 'Use the New York offset for that date: -04:00 in daylight time (mid-March to early November), -05:00 in standard time.'

export function normalizeAt(at: string): string {
  if (typeof at !== 'string' || !AT_RE.test(at)) {
    throw new ProjError(400, `time needs ISO 8601 with Z or an explicit offset. ${OFFSET_RULE}`)
  }
  const ms = Date.parse(at)
  if (!Number.isFinite(ms)) throw new ProjError(400, 'that is not a real date and time')
  const now = Date.now()
  if (ms < now + MIN_LEAD_MS) throw new ProjError(400, 'the reminder time must be at least a minute from now')
  if (ms > now + MAX_DAYS * 86_400_000) throw new ProjError(400, `the reminder time must be within ${MAX_DAYS} days`)
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00')
}

const NY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
  hour: 'numeric', minute: '2-digit', timeZoneName: 'shortOffset',
})

// The stored time is UTC. Echoed back in New York time, a wrong offset shows
// up as a wrong hour in what the session reports, instead of converting back
// cleanly to the hour it meant: "Tue, Nov 10, 2026, 8:00 AM GMT-5".
export function localOf(atUtc: string): string {
  const ms = Date.parse(atUtc)
  return Number.isFinite(ms) ? NY.format(ms) : ''
}

type ExecError = Error & { code?: number | string; killed?: boolean; stderr?: string }

// The first line lilkups wrote to stderr, which is its own "lilkups: <reason>".
// Never the error message: execFile puts the whole command line in it, and that
// includes the reminder text.
function reason(err: unknown): string {
  const e = err as ExecError
  const line = String(e.stderr ?? '').split('\n').map((l) => l.trim()).find(Boolean)
  if (line) return line.slice(0, 200)
  if (e.killed) return 'timed out'
  if (e.code === 'ENOENT') return `not installed at ${LILKUPS_BIN}`
  return `exit ${String(e.code ?? 'unknown')}`
}

export async function addLilkupsReminder(atUtc: string, name: string, message: string): Promise<string> {
  // A bare '-' makes lilkups read the message from stdin, which here is empty.
  if (!message.trim() || message === '-') throw new ProjError(400, 'the reminder needs a message')
  let stdout: string
  try {
    // --message= rather than --message <text>: argparse would read a message
    // that starts with '-' as another flag.
    ;({ stdout } = await exec(
      LILKUPS_BIN,
      ['remind', 'add', '--at', atUtc, '--name', name, '--message=' + message],
      { timeout: 10_000 },
    ))
  } catch (err) {
    throw new ProjError(502, 'Lil kups could not schedule it: ' + reason(err))
  }
  const id = stdout.trim().split(/\s+/)[0] ?? ''
  if (!LILKUPS_ID_RE.test(id)) throw new ProjError(502, 'Lil kups did not return an id')
  return id
}

// false means lilkups no longer has it: already sent and pruned, or removed by
// hand. Either way nothing is left to fire, which is all a cancel needs. Only
// lilkups' own "no reminder" answer means that: an uncaught Python error also
// exits 1, and the reminder is then still scheduled.
export async function removeLilkupsReminder(id: string): Promise<boolean> {
  if (!LILKUPS_ID_RE.test(id)) throw new ProjError(400, 'not a Lil kups reminder id')
  try {
    await exec(LILKUPS_BIN, ['remind', 'rm', id], { timeout: 10_000 })
    return true
  } catch (err) {
    const e = err as ExecError
    if (e.code === 1 && String(e.stderr ?? '').trimStart().startsWith('lilkups: no reminder')) return false
    throw new ProjError(502, 'Lil kups could not cancel it: ' + reason(err))
  }
}

export async function readLilkupsStates(): Promise<Map<string, 'pending' | 'sent' | 'failed'>> {
  const states = new Map<string, 'pending' | 'sent' | 'failed'>()
  try {
    const items = JSON.parse(await fs.promises.readFile(LILKUPS_STORE, 'utf8')) as unknown
    if (!Array.isArray(items)) return states
    for (const r of items as { id?: unknown; status?: unknown }[]) {
      if (typeof r?.id !== 'string') continue
      if (r.status === 'pending' || r.status === 'sent' || r.status === 'failed') states.set(r.id, r.status)
    }
  } catch {
    // Missing or mid-rename: every reminder then falls back to pending or gone
    // by its time, which is what the page would show a minute later anyway.
  }
  return states
}
