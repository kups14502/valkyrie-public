import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

// The Claude subscriptions this host reads usage for. They are account data,
// not code, so they live outside the repo: CLAUDE_ACCOUNTS_FILE, default
// ~/.config/valkyrie/claude-accounts.json, a JSON array of ClaudeAccount.
// Order matters: the first entry is the primary card, the default profile for
// meal estimates, and the one the session-reset alerts watch.
// Without the file there is one card, for the default ~/.claude profile.

export type ClaudeAccount = {
  id: string
  label: string
  email: string
  subscription: string
  configDir: string
}

export const DEFAULT_CLAUDE_DIR = path.join(homedir(), '.claude')

const ACCOUNTS_FILE = process.env.CLAUDE_ACCOUNTS_FILE
  || path.join(homedir(), '.config', 'valkyrie', 'claude-accounts.json')

const FALLBACK: ClaudeAccount[] = [
  { id: 'claude-default', label: 'Claude', email: '', subscription: '', configDir: DEFAULT_CLAUDE_DIR },
]

function loadAccounts(): ClaudeAccount[] {
  let raw: string
  try {
    raw = readFileSync(ACCOUNTS_FILE, 'utf8')
  } catch {
    return FALLBACK
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) throw new Error('not an array')
    const accounts = parsed
      .filter((a): a is Record<string, unknown> => Boolean(a) && typeof a === 'object')
      .filter((a) => typeof a.id === 'string' && typeof a.configDir === 'string')
      .map((a) => ({
        id: String(a.id),
        label: String(a.label ?? a.id),
        email: String(a.email ?? ''),
        subscription: String(a.subscription ?? ''),
        configDir: a.configDir === '~' || String(a.configDir).startsWith('~/')
          ? path.join(homedir(), String(a.configDir).slice(1))
          : String(a.configDir),
      }))
    if (accounts.length === 0) throw new Error('no usable entries')
    return accounts
  } catch (err) {
    console.error(`[claude-accounts] ignoring ${ACCOUNTS_FILE}: ${(err as Error).message}`)
    return FALLBACK
  }
}

export const CLAUDE_ACCOUNTS: ClaudeAccount[] = loadAccounts()
