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
 * for piped input before it starts.
 */
function run(file: string, args: string[], opts: { cwd: string; timeout: number; env: NodeJS.ProcessEnv }): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { ...opts, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(Object.assign(err, { stdout: String(stdout ?? '') }))
      else resolve({ stdout: String(stdout) })
    })
    child.stdin?.end()
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

export class ClaudeCliError extends Error {}

/** Claude's answer text for one prompt. Throws ClaudeCliError when no profile answered. */
export async function askClaude(prompt: string, opts: { model?: string; timeoutMs?: number } = {}): Promise<string> {
  const cli = CLI_CANDIDATES.find((c) => existsSync(c))
  if (!cli) throw new ClaudeCliError('the claude CLI is not installed on this host')
  const dir = await mkdtemp(path.join(tmpdir(), 'valkyrie-assist-'))
  const work = path.join(dir, 'work')
  await mkdir(work)
  const errors: string[] = []
  try {
    for (const p of creds(dir)) {
      try {
        const { stdout } = await run(cli, [
          '-p', prompt,
          '--model', opts.model ?? ASSIST_MODEL,
          // nothing to act with: the answer is all it gives
          '--disallowed-tools', 'Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,Task',
          '--output-format', 'json',
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
        })
        const envelope = extractJson(stdout) as { result?: unknown; is_error?: unknown } | null
        if (envelope && envelope.is_error === true) throw new Error(String(envelope.result ?? 'the CLI reported an error').slice(0, 200))
        const answer = envelope && typeof envelope.result === 'string' ? envelope.result : stdout
        if (!answer.trim()) throw new Error('empty answer')
        return answer
      } catch (err) {
        const e = err as Error & { killed?: boolean; code?: string; stdout?: string }
        const why = e.killed || e.code === 'ETIMEDOUT' ? 'timed out' : (e.stdout ? String(e.stdout).slice(0, 200) : e.message.slice(0, 200))
        errors.push(`${p.id}: ${why}`)
      }
    }
    throw new ClaudeCliError(`no Claude profile answered (${errors.join('; ')})`)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
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
