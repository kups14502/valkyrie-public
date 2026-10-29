import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { postInbox, type InboxLevel } from './lib/inboxStore.js'
import { CLAUDE_ACCOUNTS } from './lib/claudeAccounts.js'

// The health alerts (Claude quota and sign-ins, disk, Vaultwarden) go to the
// inbox (lib/inboxStore.ts), which keeps them and pushes them to the phone.
// They used to be Discord webhook posts, which meant the one place Brendon had
// to watch for "something is wrong" was a chat channel he had to remember to
// open, and then bare Web Push, which left no record once dismissed.
const POLL_MS = 60_000
const RESETSAT_JITTER_MS = 30 * 60_000
const DISK_THRESHOLD = 90
const CLAUDE_THRESHOLD = 90
const BACKEND = `http://127.0.0.1:${process.env.PORT || 3001}`
const STATE_PATH = path.join('/home/brendon/valkyrie/backend/data', 'alerts.json')

type AlertState = {
  sessionResetsAt: string | null
  soonAlertedFor: string | null
  claudeOver90: boolean
  diskOver90: boolean
  vaultDown: boolean
  vaultStale: boolean
  // Account ids already reported as signed out, so one dead sign-in is one
  // message rather than one a minute.
  signedOut: string[]
}

const defaultState = (): AlertState => ({
  sessionResetsAt: null,
  soonAlertedFor: null,
  claudeOver90: false,
  diskOver90: false,
  vaultDown: false,
  vaultStale: false,
  signedOut: [],
})

function loadState(): AlertState {
  try {
    if (!existsSync(STATE_PATH)) return defaultState()
    return { ...defaultState(), ...JSON.parse(readFileSync(STATE_PATH, 'utf8')) }
  } catch {
    return defaultState()
  }
}

function saveState(state: AlertState): void {
  try {
    mkdirSync(path.dirname(STATE_PATH), { recursive: true })
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))
  } catch (err) {
    console.error('[alerts] failed to save state', (err as Error).message)
  }
}

/**
 * Raise one health alert: an inbox item, pushed to every subscribed device.
 *
 * `tag` is both the inbox fold key and the lock-screen collapse key, and the
 * pairs here are deliberate: a recovery carries the SAME tag as the problem it
 * clears, so "disk back under 90%" replaces "disk at 94%" in the inbox and on
 * the lock screen instead of leaving both. Recoveries are info level but still
 * push, or the problem would stay on the lock screen. `pushUrl` is the classic
 * path the service worker maps to a v2 screen by tag (public/push-sw.js);
 * `url` is where the inbox's Open goes.
 */
async function alert(a: {
  title: string; body: string; tag: string; pushUrl: string; url: string
  source: string; level: InboxLevel; push?: boolean
}): Promise<void> {
  try {
    const r = await postInbox({
      source: a.source, level: a.level, title: a.title, body: a.body, tag: a.tag, url: a.url,
      push: a.push ?? true, pushTag: a.tag, pushUrl: a.pushUrl,
    })
    if (!r.pushed && r.pushDetail) console.error('[alerts] push failed', { title: a.title, detail: r.pushDetail })
  } catch (err) {
    console.error('[alerts] inbox post failed', { title: a.title, err: (err as Error).message })
  }
}

async function fetchJSON<T>(p: string): Promise<T | null> {
  try {
    const r = await fetch(`${BACKEND}${p}`, { headers: { 'X-Alerts-Internal': '1' } })
    if (!r.ok) return null
    return (await r.json()) as T
  } catch {
    return null
  }
}

type AIClient = {
  id: string
  label?: string
  email?: string
  authError?: string | null
  session: { isActive: boolean; endTime: string } | null
  quota: { sessionPct: number; sessionResetsAt: string | null } | null
}

type AIUsageShape = {
  aiClients?: AIClient[]
}
type SystemShape = { disk: { percent: number } }
type VaultShape = {
  container: { running: boolean }
  backups: { stale: boolean }
}

function fmtMins(ms: number): string {
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return `${mins}m`
  return `${Math.floor(mins / 60)}h${mins % 60}m`
}

function fmtClock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })
}

async function tick(state: AlertState): Promise<AlertState> {
  const [ai, sys, vault] = await Promise.all([
    fetchJSON<AIUsageShape>('/api/ai-usage'),
    fetchJSON<SystemShape>('/api/system'),
    fetchJSON<VaultShape>('/api/vault'),
  ])

  const next = { ...state }
  const now = Date.now()

  const watched = ai?.aiClients?.find((c) => c.id === CLAUDE_ACCOUNTS[0].id)
  const quota = watched?.quota
  const sessionReset = watched?.session?.isActive ? watched.session.endTime : null
  const resetSource = quota?.sessionResetsAt ?? sessionReset
  if (resetSource) {
    const resetsAt = resetSource
    const resetsAtMs = Date.parse(resetsAt)
    const prevResetsAtMs = state.sessionResetsAt ? Date.parse(state.sessionResetsAt) : NaN

    const isNewWindow = Number.isFinite(prevResetsAtMs) && resetsAtMs - prevResetsAtMs > RESETSAT_JITTER_MS
    if (isNewWindow) {
      next.soonAlertedFor = null
    }
    next.sessionResetsAt = resetsAt

    const untilReset = resetsAtMs - now

    if (quota) {
      const over = quota.sessionPct >= CLAUDE_THRESHOLD
      if (over && !state.claudeOver90) {
        await alert({
          title: `Claude session at ${quota.sessionPct}%`,
          body: `Resets at ${fmtClock(resetsAt)} ET (${fmtMins(untilReset)}).`,
          tag: 'claude-quota', pushUrl: '/dashboard', url: '/m/ai/usage', source: 'claude', level: 'warn',
        })
      }
      next.claudeOver90 = over
    }
  }

  // A dead sign-in used to sit on the dashboard unnoticed for weeks:
  // one account went out on 2026-08-07 and nobody was told. Say it once, name
  // the address to sign in with, and say it again only if it comes back and dies.
  const clients = ai?.aiClients ?? []
  if (clients.length > 0) {
    const dead = clients.filter((c) => c.authError)
    for (const c of dead) {
      if (state.signedOut.includes(c.id)) continue
      const who = c.email ? `${c.label ?? c.id} (${c.email})` : (c.label ?? c.id)
      await alert({
        title: `Claude sign-in ${c.authError}`,
        body: `${who}. Run claude /login against its config dir on odin.`,
        tag: `claude-signin-${c.id}`, pushUrl: '/dashboard', url: '/m/ai/usage', source: 'claude', level: 'warn',
      })
    }
    const recovered = state.signedOut.filter((id) => {
      const c = clients.find((x) => x.id === id)
      return c && !c.authError
    })
    for (const id of recovered) {
      const c = clients.find((x) => x.id === id)
      await alert({
        title: 'Claude sign-in restored', body: `${c?.label ?? id}.`,
        tag: `claude-signin-${id}`, pushUrl: '/dashboard', url: '/m/ai/usage', source: 'claude', level: 'info',
      })
    }
    next.signedOut = dead.map((c) => c.id)
  }

  if (sys?.disk) {
    const pct = sys.disk.percent
    const over = pct >= DISK_THRESHOLD
    if (over && !state.diskOver90) {
      await alert({
        title: `Disk at ${pct.toFixed(1)}%`, body: 'Running out of space on /.',
        tag: 'disk', pushUrl: '/services', url: '/m/system/hosts', source: 'odin', level: 'alert',
      })
    } else if (!over && state.diskOver90) {
      await alert({
        title: `Disk back under ${DISK_THRESHOLD}%`, body: `Now ${pct.toFixed(1)}%.`,
        tag: 'disk', pushUrl: '/services', url: '/m/system/hosts', source: 'odin', level: 'info',
      })
    }
    next.diskOver90 = over
  }

  if (vault) {
    const down = !vault.container.running
    if (down && !state.vaultDown) {
      await alert({
        title: 'Vaultwarden is down', body: 'The container stopped.',
        tag: 'vault-container', pushUrl: '/vault', url: '/vault', source: 'vaultwarden', level: 'alert',
      })
    } else if (!down && state.vaultDown) {
      await alert({
        title: 'Vaultwarden is back up', body: 'The container is running again.',
        tag: 'vault-container', pushUrl: '/vault', url: '/vault', source: 'vaultwarden', level: 'info',
      })
    }
    next.vaultDown = down

    const stale = vault.backups.stale
    if (stale && !state.vaultStale) {
      await alert({
        title: 'Vault backups are stale', body: 'The last backup is older than 36 hours.',
        tag: 'vault-backups', pushUrl: '/vault', url: '/vault', source: 'vaultwarden', level: 'warn',
      })
    } else if (!stale && state.vaultStale) {
      await alert({
        title: 'Vault backups are fresh again', body: 'A backup landed inside the window.',
        tag: 'vault-backups', pushUrl: '/vault', url: '/vault', source: 'vaultwarden', level: 'info',
      })
    }
    next.vaultStale = stale
  }

  return next
}

export function startAlerts(): void {
  // No webhook gate any more: these alerts are push, and the poller has to run
  // regardless so the state file keeps tracking. Without it, a subscription
  // arriving later would fire every condition that had been true all along.
  let state = loadState()
  const loop = async () => {
    try {
      state = await tick(state)
      saveState(state)
    } catch (err) {
      console.error('[alerts] tick failed', (err as Error).message)
    }
  }
  setTimeout(loop, 15_000)
  setInterval(loop, POLL_MS).unref()
  console.log(`[alerts] poller started (every ${POLL_MS / 1000}s)`)
}
