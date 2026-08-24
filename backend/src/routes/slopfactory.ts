import { Router } from 'express'
import { spawn } from 'node:child_process'
import path from 'node:path'

const router = Router()

// Read-only view of the slop-factory pipeline.
//
// `run.py stats --json` is the ONLY interface between the two codebases: it
// prints the whole payload on stdout and this route hands it to the dashboard.
// Valkyrie deliberately does not open data/factory.db. A `run.py run` batch
// writes to that database continuously, and the backend has no SQLite driver
// and is not getting one.
//
// Both paths are overridable so a broken-interpreter / broken-checkout case can
// be exercised without editing this file.
const FACTORY_DIR = process.env.SLOPFACTORY_DIR || '/home/brendon/slop-factory'
const PYTHON = process.env.SLOPFACTORY_PYTHON || path.join(FACTORY_DIR, 'venv', 'bin', 'python')
const RUN_PY = path.join(FACTORY_DIR, 'run.py')

const CACHE_TTL_MS = 10_000
// The CLI probes the filler pool with ffprobe and reads SQLite while a render
// batch may be working the same disk, so give it room; but a dashboard poll
// must never wait on it indefinitely.
const CHILD_TIMEOUT_MS = 15_000
// The payload is a few hundred bytes. Anything approaching this is a runaway
// child (a traceback loop, a stray debug print) and gets killed rather than
// buffered into the backend's heap.
const MAX_OUTPUT_BYTES = 1024 * 1024
const STDERR_TAIL_CHARS = 800
// How long a previously good payload stays servable once the CLI starts
// failing. The tab keeps its numbers (flagged stale, with the error attached)
// instead of blanking, but hour-old counts never masquerade as current.
const STALE_SERVE_MS = 10 * 60_000

// ---------- the payload contract ----------

// Mirrors `run.py stats --json` exactly. Seconds are floats rounded to 2dp,
// counts are ints, and last_render_at is the only field allowed to be null.
export type SlopStats = {
  generated_at: string
  footage: {
    episodes_ingested: number
    episodes_awaiting_clip: number
    source_seconds: number
    clips_total: number
    clips_awaiting_render: number
  }
  shorts: {
    total: number
    pending: number
    approved: number
    rejected: number
    posted: number
    seconds_total: number
  }
  gameplay: {
    files: { name: string; seconds: number }[]
    seconds_available: number
    seconds_consumed: number
    seconds_remaining: number
    shorts_supported_remaining: number
    seconds_needed_for_backlog: number
    short_on_gameplay: boolean
  }
  pipeline: {
    last_render_at: string | null
    failing_sources: number
    failing_clips: number
    budget_blocked: boolean
  }
  // Added with the publish stage (slop-factory schema v4). Optional: the validator
  // allows extra keys and an older CLI without it still passes, so the tab guards
  // for absence. Not validated field-by-field here (unknown extras are allowed
  // through), so this type is documentation, not an enforced contract.
  publishing?: {
    total: number
    failed: number
    by_platform: Record<string, number>
    last_published_at: string | null
    uploads_needed: number
    uploads_needed_by_platform: Record<string, number>
    platforms_enabled: string[]
  }
}

type ErrorKind =
  | 'spawn_failed'
  | 'timeout'
  | 'output_overflow'
  | 'exit_nonzero'
  | 'killed'
  | 'bad_json'
  | 'bad_shape'
  | 'internal'

type StatsError = {
  kind: ErrorKind
  message: string
  exit_code: number | null
  signal: string | null
  stderr_tail: string | null
}

// Always served with HTTP 200. A failing CLI is a fact about the pipeline, not
// a broken dashboard, and the tab has to be able to draw its own chrome and the
// diagnostic instead of collapsing into a generic transport error.
export type SlopStatsEnvelope = {
  ok: boolean
  generated_at: string
  stats: SlopStats | null
  // true when `stats` is a cached payload from an earlier successful run kept
  // on screen while `error` explains why the current one failed.
  stale: boolean
  error: StatsError | null
}

// ---------- validation ----------

const isObj = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const isInt = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v)
const isNum = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown): boolean => typeof v === 'string'

const INT_FIELDS: Record<string, string[]> = {
  footage: ['episodes_ingested', 'episodes_awaiting_clip', 'clips_total', 'clips_awaiting_render'],
  shorts: ['total', 'pending', 'approved', 'rejected', 'posted'],
  gameplay: ['shorts_supported_remaining'],
  pipeline: ['failing_sources', 'failing_clips'],
}
const NUM_FIELDS: Record<string, string[]> = {
  footage: ['source_seconds'],
  shorts: ['seconds_total'],
  gameplay: ['seconds_available', 'seconds_consumed', 'seconds_remaining', 'seconds_needed_for_backlog'],
}
const BOOL_FIELDS: Record<string, string[]> = {
  gameplay: ['short_on_gameplay'],
  pipeline: ['budget_blocked'],
}

/**
 * Every issue that makes a parsed payload unusable, or [] when it matches the
 * contract. Checked rather than trusted: a silent drift in the CLI would
 * otherwise reach the UI as blank tiles or NaN, and this names the field
 * instead. Unknown extra keys are allowed through untouched so the CLI can add
 * fields without a route change.
 */
function validate(doc: unknown): string[] {
  if (!isObj(doc)) return ['payload is not a JSON object']
  const issues: string[] = []
  if (!isStr(doc.generated_at)) issues.push('generated_at must be a string')

  for (const section of ['footage', 'shorts', 'gameplay', 'pipeline']) {
    if (!isObj(doc[section])) {
      issues.push(`${section} must be an object`)
      continue
    }
    const obj = doc[section] as Record<string, unknown>
    for (const key of INT_FIELDS[section] ?? []) {
      if (!isInt(obj[key])) issues.push(`${section}.${key} must be an integer`)
    }
    for (const key of NUM_FIELDS[section] ?? []) {
      if (!isNum(obj[key])) issues.push(`${section}.${key} must be a number`)
    }
    for (const key of BOOL_FIELDS[section] ?? []) {
      if (typeof obj[key] !== 'boolean') issues.push(`${section}.${key} must be a boolean`)
    }
  }

  const gameplay = isObj(doc.gameplay) ? doc.gameplay : null
  if (gameplay) {
    if (!Array.isArray(gameplay.files)) {
      issues.push('gameplay.files must be an array')
    } else {
      gameplay.files.forEach((entry, i) => {
        if (!isObj(entry) || !isStr(entry.name) || !isNum(entry.seconds)) {
          issues.push(`gameplay.files[${i}] must be {name: string, seconds: number}`)
        }
      })
    }
  }

  const pipeline = isObj(doc.pipeline) ? doc.pipeline : null
  if (pipeline && pipeline.last_render_at !== null && !isStr(pipeline.last_render_at)) {
    issues.push('pipeline.last_render_at must be a string or null')
  }

  return issues
}

// ---------- child process ----------

type ChildResult = {
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
  timedOut: boolean
  overflowed: boolean
  spawnError: NodeJS.ErrnoException | null
}

/**
 * Absolute paths out of anything we echo back. The operator needs to see which
 * stage broke, not the layout of every unrelated directory on the box.
 */
function redact(text: string): string {
  return text
    .split(FACTORY_DIR).join('<slop-factory>')
    .replace(/\/home\/[^/\s:"']+/g, '~')
}

function tail(text: string, chars: number): string | null {
  const trimmed = redact(text).trim()
  if (!trimmed) return null
  return trimmed.length > chars ? `...${trimmed.slice(-chars)}` : trimmed
}

/**
 * Run `run.py stats --json` once and collect the result. Never rejects: every
 * failure mode comes back in the resolved value so the caller has one path.
 *
 * The child gets its own process group, so a timeout kill takes the whole tree
 * with it. Killing the python process alone would leave an ffprobe it spawned
 * running with nobody waiting on it.
 */
function runStatsCli(): Promise<ChildResult> {
  return new Promise((resolve) => {
    const base: ChildResult = {
      code: null, signal: null, stdout: '', stderr: '',
      timedOut: false, overflowed: false, spawnError: null,
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(PYTHON, [RUN_PY, 'stats', '--json'], {
        cwd: FACTORY_DIR,
        detached: true,
        // stdin is closed so a CLI that ever prompts fails fast instead of
        // hanging until the timeout.
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      resolve({ ...base, spawnError: err as NodeJS.ErrnoException })
      return
    }

    let stdout = ''
    let stderr = ''
    let bytes = 0
    let timedOut = false
    let overflowed = false
    let settled = false

    const killTree = () => {
      const pid = child.pid
      if (pid == null) return
      // Negative pid targets the group created by detached: true.
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree()
    }, CHILD_TIMEOUT_MS)
    timer.unref()

    const finish = (result: ChildResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    child.stdout?.on('data', (buf: Buffer) => {
      bytes += buf.length
      if (bytes > MAX_OUTPUT_BYTES) {
        overflowed = true
        killTree()
        return
      }
      stdout += buf.toString('utf8')
    })
    child.stderr?.on('data', (buf: Buffer) => {
      bytes += buf.length
      if (bytes > MAX_OUTPUT_BYTES) {
        overflowed = true
        killTree()
        return
      }
      // Only the tail is ever reported, so only the tail is kept.
      stderr = (stderr + buf.toString('utf8')).slice(-4 * STDERR_TAIL_CHARS)
    })

    // ENOENT for a missing interpreter or a missing cwd arrives here, not as a
    // throw from spawn().
    child.on('error', (err) => {
      finish({ ...base, stdout, stderr, timedOut, overflowed, spawnError: err as NodeJS.ErrnoException })
    })
    // 'close' rather than 'exit': it fires once both pipes have drained, so the
    // last line of a traceback is never lost.
    child.on('close', (code, signal) => {
      finish({ ...base, code, signal, stdout, stderr, timedOut, overflowed })
    })
  })
}

/** Why the run is unusable, or null when it produced a clean exit. */
function classify(r: ChildResult): StatsError | null {
  const stderrTail = tail(r.stderr, STDERR_TAIL_CHARS)
  if (r.spawnError) {
    return {
      kind: 'spawn_failed',
      message: `could not start the slop-factory CLI (${r.spawnError.code ?? 'spawn error'}): ${redact(r.spawnError.message)}`,
      exit_code: null,
      signal: null,
      stderr_tail: stderrTail,
    }
  }
  if (r.timedOut) {
    return {
      kind: 'timeout',
      message: `stats --json did not finish within ${CHILD_TIMEOUT_MS / 1000}s and was killed`,
      exit_code: r.code,
      signal: r.signal,
      stderr_tail: stderrTail,
    }
  }
  if (r.overflowed) {
    return {
      kind: 'output_overflow',
      message: `stats --json printed more than ${MAX_OUTPUT_BYTES} bytes and was killed`,
      exit_code: r.code,
      signal: r.signal,
      stderr_tail: stderrTail,
    }
  }
  if (r.code === 0) return null
  if (r.code == null) {
    return {
      kind: 'killed',
      message: `stats --json was terminated by ${r.signal ?? 'an unknown signal'}`,
      exit_code: null,
      signal: r.signal,
      stderr_tail: stderrTail,
    }
  }
  return {
    kind: 'exit_nonzero',
    message: `stats --json exited ${r.code}`,
    exit_code: r.code,
    signal: r.signal,
    stderr_tail: stderrTail,
  }
}

// ---------- assembly ----------

let cache: { at: number; envelope: SlopStatsEnvelope } | null = null
let lastGood: { at: number; stats: SlopStats } | null = null
// One probe at a time. The dashboard polls and several clients can miss the
// cache together; without this each miss would spawn its own python.
let inflight: Promise<SlopStatsEnvelope> | null = null

function envelope(stats: SlopStats | null, error: StatsError | null): SlopStatsEnvelope {
  const now = Date.now()
  if (!error && stats) {
    lastGood = { at: now, stats }
    return { ok: true, generated_at: new Date(now).toISOString(), stats, stale: false, error: null }
  }
  const usable = lastGood && now - lastGood.at < STALE_SERVE_MS ? lastGood.stats : null
  return {
    ok: false,
    generated_at: new Date(now).toISOString(),
    stats: usable,
    stale: usable != null,
    error,
  }
}

async function probe(): Promise<SlopStatsEnvelope> {
  const result = await runStatsCli()
  const failure = classify(result)
  if (failure) return envelope(null, failure)

  let doc: unknown
  try {
    doc = JSON.parse(result.stdout)
  } catch {
    const head = redact(result.stdout).trim().slice(0, 200)
    return envelope(null, {
      kind: 'bad_json',
      message: `stats --json exited 0 but stdout is not JSON: ${head ? `"${head}"` : '(empty)'}`,
      exit_code: result.code,
      signal: null,
      stderr_tail: tail(result.stderr, STDERR_TAIL_CHARS),
    })
  }

  const issues = validate(doc)
  if (issues.length > 0) {
    const shown = issues.slice(0, 6).join('; ')
    const more = issues.length > 6 ? ` (+${issues.length - 6} more)` : ''
    return envelope(null, {
      kind: 'bad_shape',
      message: `stats --json does not match the contract: ${shown}${more}`,
      exit_code: result.code,
      signal: null,
      stderr_tail: tail(result.stderr, STDERR_TAIL_CHARS),
    })
  }

  return envelope(doc as SlopStats, null)
}

/** Cached, single-flight stats. Resolves for every outcome, good or bad. */
async function getStats(): Promise<SlopStatsEnvelope> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.envelope
  if (inflight) return inflight

  // Failures are cached for the same window as successes, so a broken CLI gets
  // one child per 10s rather than one per poll per client.
  inflight = probe()
    .then((data) => {
      cache = { at: Date.now(), envelope: data }
      return data
    })
    .finally(() => { inflight = null })

  return inflight
}

// ---------- routes ----------

router.get('/slopfactory/stats', async (_req, res) => {
  try {
    res.json(await getStats())
  } catch (err) {
    // Unreachable by design: getStats() resolves on every failure path. Kept so
    // a later edit cannot turn a pipeline problem into a 500 that blanks the
    // tab.
    console.error('[slopfactory] unexpected failure', err)
    res.json(envelope(null, {
      kind: 'internal',
      message: 'the stats route failed unexpectedly',
      exit_code: null,
      signal: null,
      stderr_tail: null,
    }))
  }
})

export default router
