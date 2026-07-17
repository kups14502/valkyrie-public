import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { ok, fail, selfApi } from './util.js'

const exec = promisify(execFile)

// Ops tools: server status, trading report, service control, lights, and
// Valkyrie self-update. Status reads go through the backend's own REST API
// (loopback); updates shell out the same way the documented manual flow does.

const VALKYRIE_ROOT = process.env.VALKYRIE_ROOT || '/home/brendon/valkyrie'
const UPDATE_LOG = '/tmp/valkyrie-assistant-update.log'
const SHIP_LOG = '/tmp/valkyrie-ship.log'

// Units/containers the assistant must never bounce: they carry remote access
// to the box (or the media downloads themselves).
const RESTART_DENY = /^(sshd|tailscaled|smb|nmb|docker|containerd|NetworkManager|wpa_supplicant|systemd-.*)(\.service)?$/i

function detached(script: string, log: string) {
  // setsid + detached so the child survives a backend restart (which some of
  // these scripts themselves trigger). The leading sleep gives the agent time
  // to finish its reply and close the SSE stream before the service bounces.
  const child = spawn('setsid', ['bash', '-lc', `{ ${script} ; } >> ${log} 2>&1`], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
}

async function tailFile(file: string, lines = 15): Promise<string | null> {
  try {
    const raw = await readFile(file, 'utf8')
    return raw.trimEnd().split('\n').slice(-lines).join('\n')
  } catch {
    return null
  }
}

export const opsTools = [
  tool(
    'trading_status',
    'Current trade-bot status: portfolio equity, open positions with P&L, realized P&L, market regime/summary, latest run plan, and trades executed today. Read-only — the trade bot is autonomous and trades cannot be placed from here.',
    {},
    async () => {
      try {
        const t = await selfApi<any>('/trading')
        const positions = [
          ...(t.portfolio?.stockPositions ?? []),
          ...(t.portfolio?.cryptoPositions ?? []),
          ...(t.portfolio?.optionsPositions ?? []),
        ]
        return ok({
          lastUpdated: t.lastUpdated,
          marketRegime: t.marketRegime,
          marketSummary: t.marketSummary,
          equity: t.portfolio?.equity ?? null,
          buyingPower: t.portfolio?.buyingPower ?? null,
          positions,
          realizedTotalUSD: t.realized?.totalUSD ?? 0,
          runsToday: t.runsToday,
          executedToday: t.executedToday,
          latestRunSummary: t.latestRun?.sonnetSummary ?? null,
          latestPlan: t.latestRun?.plan ?? null,
          signals: t.signals,
          equityHistory: (t.equityHistory ?? []).slice(-30),
        })
      } catch (e) { return fail(e) }
    },
  ),
  tool(
    'system_status',
    "Odin server health: CPU, memory, disk, uptime. Use for 'how's the server doing'.",
    {},
    async () => {
      try { return ok(await selfApi('/system')) } catch (e) { return fail(e) }
    },
  ),
  tool(
    'service_health',
    'Health of every service on odin (Plex, Home Assistant, Radarr, Sonarr, qBittorrent, Vaultwarden, Valkyrie itself, …): alive/down plus latency. Use to answer "is plex up".',
    {},
    async () => {
      try { return ok({ services: await selfApi('/launcher') }) } catch (e) { return fail(e) }
    },
  ),
  tool(
    'restart_service',
    'Restart a docker container (e.g. plex, radarr, homeassistant) or a systemd user service on odin. Destructive: confirm with the user first and pass confirm=true. Core access services (ssh, tailscale, docker) are refused.',
    {
      kind: z.enum(['container', 'service']),
      name: z.string().min(1).max(100),
      confirm: z.boolean(),
    },
    async (args) => {
      try {
        if (!args.confirm) return fail(new Error('not confirmed'))
        if (RESTART_DENY.test(args.name)) return fail(new Error(`refusing to restart ${args.name}: it carries remote access to the server`))
        await selfApi('/services/restart', { method: 'POST', body: { kind: args.kind, name: args.name }, timeoutMs: 35_000 })
        return ok({ restarted: args.name })
      } catch (e) { return fail(e) }
    },
  ),
  tool(
    'list_lights',
    'List Home Assistant lights with on/off state and brightness.',
    {},
    async () => {
      try { return ok({ lights: await selfApi('/lights') }) } catch (e) { return fail(e) }
    },
  ),
  tool(
    'set_lights',
    'Turn lights on/off, set brightness (percent), or color. entity_ids come from list_lights.',
    {
      entity_ids: z.array(z.string().min(1)).min(1).max(20),
      state: z.enum(['on', 'off']),
      brightness_pct: z.number().min(1).max(100).optional(),
      rgb_color: z.tuple([z.number().min(0).max(255), z.number().min(0).max(255), z.number().min(0).max(255)]).optional(),
    },
    async (args) => {
      try {
        await selfApi('/lights/turn', {
          method: 'POST',
          body: {
            entity_id: args.entity_ids,
            state: args.state,
            // /lights/turn takes raw HA brightness 0-255.
            ...(args.brightness_pct != null ? { brightness: Math.round((args.brightness_pct / 100) * 255) } : {}),
            ...(args.rgb_color ? { rgb_color: args.rgb_color } : {}),
          },
        })
        return ok({ done: true, entities: args.entity_ids, state: args.state })
      } catch (e) { return fail(e) }
    },
  ),
  tool(
    'update_valkyrie',
    [
      'Update the Valkyrie project itself. action=check: report pending commits on origin/main and recent update logs (fast, safe).',
      'action=backend: pull latest code, rebuild the backend + kiosk UI, and restart valkyrie-api — THE ASSISTANT DISCONNECTS for ~a minute; warn the user in your reply BEFORE calling this.',
      'action=apps: run the full desktop/mobile release pipeline (scripts/ship.sh) in the background.',
    ].join(' '),
    { action: z.enum(['check', 'backend', 'apps']) },
    async (args) => {
      try {
        if (args.action === 'check') {
          await exec('git', ['-C', VALKYRIE_ROOT, 'fetch', '--quiet', 'origin', 'main'], { timeout: 20_000 }).catch(() => null)
          const [behind, remoteHead, localHead] = await Promise.all([
            exec('git', ['-C', VALKYRIE_ROOT, 'rev-list', '--count', 'HEAD..origin/main'], { timeout: 10_000 })
              .then((r) => Number(r.stdout.trim())).catch(() => null),
            exec('git', ['-C', VALKYRIE_ROOT, 'log', '-1', '--format=%s', 'origin/main'], { timeout: 10_000 })
              .then((r) => r.stdout.trim()).catch(() => null),
            exec('git', ['-C', VALKYRIE_ROOT, 'log', '-1', '--format=%h %s (%cr)'], { timeout: 10_000 })
              .then((r) => r.stdout.trim()).catch(() => null),
          ])
          let version: string | null = null
          try {
            const conf = JSON.parse(await readFile(path.join(VALKYRIE_ROOT, 'frontend/src-tauri/tauri.conf.json'), 'utf8'))
            version = conf.version ?? null
          } catch { /* fine */ }
          return ok({
            version,
            localHead,
            commitsBehindOriginMain: behind,
            latestRemoteCommit: remoteHead,
            backendUpdateLog: await tailFile(UPDATE_LOG),
            releaseLog: await tailFile(SHIP_LOG, 8),
          })
        }
        if (args.action === 'backend') {
          detached(
            `sleep 8; echo "== assistant-triggered backend update $(date -Is) =="; cd ${VALKYRIE_ROOT} && git pull --ff-only && cd backend && npm install --no-audit --no-fund && npm run build && cd ../frontend && npm install --no-audit --no-fund && npm run build:kiosk && systemctl --user restart valkyrie-api.service`,
            UPDATE_LOG,
          )
          return ok({ started: 'backend update', note: 'backend restarts in ~a minute; the assistant will briefly disconnect', log: UPDATE_LOG })
        }
        detached(`echo "== assistant-triggered release $(date -Is) =="; cd ${VALKYRIE_ROOT} && bash scripts/ship.sh`, SHIP_LOG)
        return ok({ started: 'app release pipeline (ship.sh)', note: 'builds desktop installers and publishes a GitHub release; takes several minutes', log: SHIP_LOG })
      } catch (e) { return fail(e) }
    },
  ),
]
