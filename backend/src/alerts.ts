import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL
const POLL_MS = 60_000
const SOON_WINDOW_MS = 30 * 60_000
const DISK_THRESHOLD = 90
const CLAUDE_THRESHOLD = 90
const BACKEND = `http://127.0.0.1:${process.env.PORT || 3001}`
const STATE_PATH = path.join('/home/brendon/master-control/backend/data', 'alerts.json')

type AlertState = {
  sessionResetsAt: string | null
  soonAlertedFor: string | null
  claudeOver90: boolean
  diskOver90: boolean
  vaultDown: boolean
  vaultStale: boolean
}

const defaultState = (): AlertState => ({
  sessionResetsAt: null,
  soonAlertedFor: null,
  claudeOver90: false,
  diskOver90: false,
  vaultDown: false,
  vaultStale: false,
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

async function postDiscord(content: string): Promise<void> {
  if (!WEBHOOK_URL) return
  try {
    const r = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    })
    if (!r.ok) {
      console.error('[alerts] webhook failed', r.status, await r.text().catch(() => ''))
    }
  } catch (err) {
    console.error('[alerts] webhook error', (err as Error).message)
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

type AIUsageShape = {
  claude: {
    quota: { sessionPct: number; sessionResetsAt: string | null } | null
  }
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

  const quota = ai?.claude?.quota
  if (quota?.sessionResetsAt) {
    const resetsAt = quota.sessionResetsAt
    const resetsAtMs = Date.parse(resetsAt)

    if (state.sessionResetsAt && state.sessionResetsAt !== resetsAt) {
      await postDiscord(`🟢 **Claude session reset** — fresh 5h window. Next reset at ${fmtClock(resetsAt)} ET.`)
      next.soonAlertedFor = null
    }
    next.sessionResetsAt = resetsAt

    const untilReset = resetsAtMs - now
    if (untilReset > 0 && untilReset <= SOON_WINDOW_MS && state.soonAlertedFor !== resetsAt) {
      await postDiscord(`⏳ **Claude session resets in ~${fmtMins(untilReset)}** — at ${fmtClock(resetsAt)} ET. Usage: ${quota.sessionPct}%.`)
      next.soonAlertedFor = resetsAt
    }

    const over = quota.sessionPct >= CLAUDE_THRESHOLD
    if (over && !state.claudeOver90) {
      await postDiscord(`🔴 **Claude session at ${quota.sessionPct}%** — resets at ${fmtClock(resetsAt)} ET (${fmtMins(untilReset)}).`)
    }
    next.claudeOver90 = over
  }

  if (sys?.disk) {
    const pct = sys.disk.percent
    const over = pct >= DISK_THRESHOLD
    if (over && !state.diskOver90) {
      await postDiscord(`🔴 **Disk at ${pct.toFixed(1)}%** — running out of space on /.`)
    } else if (!over && state.diskOver90) {
      await postDiscord(`🟢 **Disk back under ${DISK_THRESHOLD}%** — now ${pct.toFixed(1)}%.`)
    }
    next.diskOver90 = over
  }

  if (vault) {
    const down = !vault.container.running
    if (down && !state.vaultDown) {
      await postDiscord(`🔴 **Vaultwarden container down.**`)
    } else if (!down && state.vaultDown) {
      await postDiscord(`🟢 **Vaultwarden container back up.**`)
    }
    next.vaultDown = down

    const stale = vault.backups.stale
    if (stale && !state.vaultStale) {
      await postDiscord(`🟡 **Vault backups stale** — last backup is older than 36h.`)
    } else if (!stale && state.vaultStale) {
      await postDiscord(`🟢 **Vault backups fresh again.**`)
    }
    next.vaultStale = stale
  }

  return next
}

export function startAlerts(): void {
  if (!WEBHOOK_URL) {
    console.log('[alerts] DISCORD_WEBHOOK_URL not set — alerts disabled')
    return
  }
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
