import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CLAUDE_ACCOUNTS } from './claudeAccounts.js'
import { poolTokensByRoom } from './accountSwitch.js'

// One headless Claude answer from the Claude Code CLI under a signed-in odin
// profile, the way routes/meals.ts estimates a plate: an OAuth sign-in posted
// straight at /v1/messages is refused, so the CLI is the only way that
// credential can be spent. Used by the Capture line and the morning brief.
//
// The CLI starts in an empty directory with no tools allowed, so the model can
// only answer; whatever the answer asks for is done (or refused) by the caller.
//
// Credentials, in order: the switcher's year-long pool tokens with the most
// 5-hour room (profile sign-ins on odin expire; 4 of 5 had on 2026-10-29), then
// the signed-in profiles. One that fails (out of usage, signed out) is
// followed by the next, three tries at most.

/**
 * execFile with stdin closed at once: an open stdin makes `claude -p` wait 3 s
 * for piped input before it starts. input: written to stdin first, which
 * `claude -p` with no prompt argument reads as the prompt.
 */
function run(file: string, args: string[], opts: { cwd: string; timeout: number; env: NodeJS.ProcessEnv; signal?: AbortSignal; input?: string }): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const { signal, input, ...rest } = opts
    const child = execFile(file, args, { ...rest, ...(signal ? { signal } : {}), maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }))
      else resolve({ stdout: String(stdout) })
    })
    // a CLI that exits before it read it all (a bad flag, a kill) is reported by the callback, never as an EPIPE throw
    child.stdin?.on('error', () => {})
    child.stdin?.end(input)
  })
}

const CLI_CANDIDATES = [
  process.env.CLAUDE_CLI_PATH,
  '/home/brendon/.local/bin/claude',
  '/usr/local/bin/claude',
].filter((p): p is string => Boolean(p))

export const ASSIST_MODEL = process.env.ASSIST_MODEL || 'claude-sonnet-5'

/** Pull the JSON object out of an answer that may be fenced or padded. */
export function extractJson(text: string): unknown | null {
  // bare JSON first: the CLI envelope of a fenced answer holds the fence inside its escaped result string
  try {
    const whole = JSON.parse(text.trim()) as unknown
    if (whole && typeof whole === 'object' && !Array.isArray(whole)) return whole
  } catch { /* not bare JSON */ }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const body = fenced ? fenced[1] : text
  const first = body.indexOf('{')
  const last = body.lastIndexOf('}')
  if (first < 0 || last <= first) return null
  try {
    return JSON.parse(body.slice(first, last + 1))
  } catch {
    return null
  }
}

type Cred = { id: string; env: Record<string, string> }

/** What to try: pool tokens by room, then the profiles (the configured one first). */
function creds(scratch: string): Cred[] {
  const pool = poolTokensByRoom().map((t): Cred => ({
    id: `${t.id} (pool)`,
    // a config dir of its own, so the token run never touches a profile's files
    env: { CLAUDE_CODE_OAUTH_TOKEN: t.token, CLAUDE_CONFIG_DIR: path.join(scratch, 'cfg') },
  }))
  const want = process.env.ASSIST_CLAUDE_ACCOUNT || process.env.MEALS_CLAUDE_ACCOUNT
  const first = CLAUDE_ACCOUNTS.find((a) => a.id === want) ?? CLAUDE_ACCOUNTS[0]
  const profiles = [first, ...CLAUDE_ACCOUNTS.filter((a) => a !== first)].filter(Boolean)
    .map((a): Cred => ({ id: a.id, env: { CLAUDE_CODE_OAUTH_TOKEN: '', CLAUDE_CONFIG_DIR: a.configDir } }))
  return [...pool, ...profiles].slice(0, 3)
}

/**
 * detail: what the CLI itself printed on each failure (stdout or stderr), for a caller that must tell one failure from another.
 * costUsd: what the failed runs cost by the CLI's own count (a run stopped by --max-budget-usd spent its budget), or null.
 */
export class ClaudeCliError extends Error {
  detail = ''
  costUsd: number | null = null
}

const cliError = (message: string, detail: string[] = [], costUsd: number | null = null) =>
  Object.assign(new ClaudeCliError(message), { detail: detail.join('\n').slice(0, 4000), costUsd })

/**
 * The environment a run reads 'minimal': what the CLI needs to start and reach the network, nothing of this
 * process's own settings (a run whose prompt holds outside text must not find the backend's keys in its env).
 */
const MINIMAL_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TERM',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy']

const baseEnv = (env: 'inherit' | 'minimal' | undefined): NodeJS.ProcessEnv =>
  (env === 'minimal' ? Object.fromEntries(MINIMAL_ENV.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])) : process.env)

/** The CLI's cost figure in its JSON envelope, or null. */
const costOf = (out: string | undefined): number | null => {
  if (!out) return null
  const env = extractJson(out) as { total_cost_usd?: unknown } | null
  return typeof env?.total_cost_usd === 'number' && Number.isFinite(env.total_cost_usd) ? env.total_cost_usd : null
}

// a failed execFile: what it printed, never its message (the whole command line, prompt included);
// anything else (an is_error answer, an empty one): the message
const said = (e: { stdout?: string; stderr?: string; code?: unknown; signal?: unknown; message: string }) =>
  e.stdout !== undefined || e.stderr !== undefined
    ? [e.stdout, e.stderr].filter(Boolean).join('\n').slice(0, 1500) || `the CLI exited (${String(e.code ?? e.signal ?? 'no output')})`
    : e.message.slice(0, 1500)

/** Claude's answer text for one prompt. Throws ClaudeCliError when no profile answered. */
export async function askClaude(prompt: string, opts: { model?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<string> {
  const cli = CLI_CANDIDATES.find((c) => existsSync(c))
  if (!cli) throw new ClaudeCliError('the claude CLI is not installed on this host')
  const dir = await mkdtemp(path.join(tmpdir(), 'valkyrie-assist-'))
  const work = path.join(dir, 'work')
  await mkdir(work)
  const errors: string[] = []
  const details: string[] = []
  try {
    for (const p of creds(dir)) {
      if (opts.signal?.aborted) throw new ClaudeCliError('stopped')
      try {
        const { stdout } = await run(cli, [
          '-p', prompt,
          '--model', opts.model ?? ASSIST_MODEL,
          // nothing to act with: the answer is all it gives
          '--disallowed-tools', 'Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,Task',
          '--output-format', 'json',
          // a signed-in profile would otherwise keep the prompt as a session transcript
          '--no-session-persistence',
        ], {
          cwd: work,
          timeout: opts.timeoutMs ?? 120_000,
          env: {
            ...process.env,
            ...p.env,
            // a key in the environment shadows the sign-in, the credential this exists to spend
            ANTHROPIC_API_KEY: '',
            ANTHROPIC_AUTH_TOKEN: '',
          },
          signal: opts.signal,
        })
        const envelope = extractJson(stdout) as { result?: unknown; is_error?: unknown } | null
        if (envelope && envelope.is_error === true) throw new Error(String(envelope.result ?? 'the CLI reported an error').slice(0, 200))
        const answer = envelope && typeof envelope.result === 'string' ? envelope.result : stdout
        if (!answer.trim()) throw new Error('empty answer')
        return answer
      } catch (err) {
        if (opts.signal?.aborted) throw new ClaudeCliError('stopped')
        const e = err as Error & { killed?: boolean; code?: string; stdout?: string; stderr?: string }
        const why = e.killed || e.code === 'ETIMEDOUT' ? 'timed out' : said(e).slice(0, 200)
        errors.push(`${p.id}: ${why}`)
        details.push(said(e))
      }
    }
    throw cliError(`no Claude profile answered (${errors.join('; ')})`, details)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

export type CliRun = { text: string; cred: string; costUsd: number | null; turns: number | null; durationMs: number | null }

/**
 * A headless run with tools, for the work agents (lib/agents.ts): the caller
 * passes every flag but the credential, in a working directory it owns. A
 * credential that fails is followed by the next only while retryable() says
 * the run has not acted yet, so a run that already posted or proposed is
 * never repeated under another account. retryable() gets the failure in
 * words, so a caller can stop on an error no other account would fix.
 *
 * signal (optional) stops the run: the child is killed and the call throws
 * ClaudeCliError('stopped'), with no further credential tried. env 'minimal':
 * the run gets only MINIMAL_ENV and the credential, not this process's
 * environment. A run that fails after it spent (a budget stop) throws with
 * that cost on the error.
 */
/** input: the prompt on stdin, for args that hold no prompt (one past the 128 KB a Linux argument can carry). */
export async function runClaude(args: string[], opts: { cwd: string; scratch: string; timeoutMs: number; retryable: (why: string) => boolean; signal?: AbortSignal; env?: 'inherit' | 'minimal'; input?: string }): Promise<CliRun> {
  const cli = CLI_CANDIDATES.find((c) => existsSync(c))
  if (!cli) throw new ClaudeCliError('the claude CLI is not installed on this host')
  const errors: string[] = []
  const details: string[] = []
  let spent: number | null = null
  for (const p of creds(opts.scratch)) {
    if (opts.signal?.aborted) throw new ClaudeCliError('stopped')
    try {
      const { stdout } = await run(cli, args, {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        env: { ...baseEnv(opts.env), ...p.env, ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' },
        signal: opts.signal,
        input: opts.input,
      })
      const env = extractJson(stdout) as { result?: unknown; is_error?: unknown; total_cost_usd?: unknown; num_turns?: unknown; duration_ms?: unknown } | null
      if (env && env.is_error === true) {
        const cost = costOf(stdout)
        if (cost !== null) spent = (spent ?? 0) + cost
        throw new Error(String(env.result ?? 'the CLI reported an error').slice(0, 300))
      }
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
      return {
        text: env && typeof env.result === 'string' ? env.result : stdout.slice(0, 4000),
        cred: p.id,
        costUsd: num(env?.total_cost_usd),
        turns: num(env?.num_turns),
        durationMs: num(env?.duration_ms),
      }
    } catch (err) {
      if (opts.signal?.aborted) throw new ClaudeCliError('stopped')
      const e = err as Error & { killed?: boolean; code?: string; stdout?: string; stderr?: string }
      const cost = costOf(e.stdout)
      if (cost !== null) spent = (spent ?? 0) + cost
      // never e.message for a failed execFile: it is the whole command line, the prompt included
      const why = e.killed || e.code === 'ETIMEDOUT' ? 'timed out' : said(e).slice(0, 300)
      errors.push(`${p.id}: ${why}`)
      details.push(said(e))
      if (!opts.retryable(`${why}\n${said(e)}`) || why === 'timed out') break
    }
  }
  throw cliError(errors.join('; ') || 'no Claude profile answered', details, spent)
}

// ---------------------------------------------------------- New York time ----

const NY_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})

function nyParts(ms: number): Record<string, number> {
  return Object.fromEntries(NY_PARTS.formatToParts(ms).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]))
}

/** New York's UTC offset in minutes at an instant (-240 in daylight time, -300 in standard). */
export function nyOffsetMinutes(ms: number): number {
  const p = nyParts(ms)
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / 60_000) * 60_000) / 60_000)
}

/** A New York wall-clock time, 'YYYY-MM-DDTHH:mm', as an instant. */
export function nyWallToMs(wall: string): number {
  const [d, t = '00:00'] = wall.split('T')
  const [y, m, day] = d.split('-').map(Number)
  const [hh, mm] = t.split(':').map(Number)
  const naive = Date.UTC(y, m - 1, day, hh, mm)
  let utc = naive - nyOffsetMinutes(naive) * 60_000
  utc = naive - nyOffsetMinutes(utc) * 60_000
  return utc
}

/** "Thursday, 2026-10-29, 1:42 PM": how the prompts tell Claude when "now" is. */
export function nyNowLine(ms = Date.now()): string {
  const day = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'long' }).format(ms)
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms)
  const time = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(ms)
  return `${day}, ${date}, ${time} New York time`
}
