import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'

// The work agents' private facts: which franchises exist, their names, PSA
// credentials file, Brendon's ids there, their own mail domains, the support
// address replies copy, and what their triage agent must know. Client and
// employer names never live in this repository (scripts/public-guard.sh
// refuses them), so they live in odin's ~/.config/valkyrie/work-agents.json,
// mode 600, read here and reread when it changes. Without the file there are
// no franchises: no triage agents, no ticket polling, no mail routing.
//
// {
//   "franchises": [{
//     "key": "<the project area key>", "label": "<short name>", "company": "<full name>",
//     "envFile": "<PSA credentials file in this folder>", "web": "https://wwN.autotask.net",
//     "brendonResource": 0, "brendonRole": 0, "ticketCategory": 0,
//     "supportCc": "<address replies copy>", "ownDomains": ["<colleague mail domains>"],
//     "teams": false,
//     "agent": { "id": "<key>-triage", "name": "...", "role": "...", "topic": "..." },
//     "brief": "<what this franchise's triage agent must know>"
//   }],
//   "self": ["<Brendon's own addresses>"],
//   "mailboxRoutes": { "<mailbox key>": "<franchise key>" },
//   "defaultFranchise": "<franchise for mail nobody can place>",
//   "teamsFranchise": "<franchise the Teams feed belongs to>",
//   "skipDomains": ["<senders the agents never need>"]
// }

export type FranchiseConf = {
  key: string
  label: string
  company: string
  envFile: string
  web: string
  brendonResource: number
  brendonRole?: number
  ticketCategory?: number
  supportCc: string
  ownDomains: string[]
  teams?: boolean
  agent: { id: string; name: string; role: string; topic: string }
  brief: string
}

export type WorkConf = {
  franchises: FranchiseConf[]
  self: string[]
  mailboxRoutes: Record<string, string>
  defaultFranchise: string | null
  teamsFranchise: string | null
  skipDomains: string[]
}

export const CONF_DIR = process.env.VALKYRIE_CONF_DIR || path.join(homedir(), '.config', 'valkyrie')
const FILE = process.env.WORK_AGENTS_FILE || path.join(CONF_DIR, 'work-agents.json')
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

const EMPTY: WorkConf = { franchises: [], self: [], mailboxRoutes: {}, defaultFranchise: null, teamsFranchise: null, skipDomains: [] }
let cache: { mtime: number; conf: WorkConf } | null = null
let warned = false

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase()) : [])

function parse(raw: unknown): WorkConf {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const franchises: FranchiseConf[] = []
  for (const f of Array.isArray(o.franchises) ? o.franchises as Record<string, unknown>[] : []) {
    const agent = (f.agent ?? {}) as Record<string, unknown>
    const key = String(f.key ?? '')
    const id = String(agent.id ?? '')
    if (!KEY_RE.test(key) || !KEY_RE.test(id) || typeof f.envFile !== 'string' || !/^[\w.-]+$/.test(f.envFile)) continue
    franchises.push({
      key, label: String(f.label ?? key), company: String(f.company ?? f.label ?? key), envFile: f.envFile,
      web: typeof f.web === 'string' && f.web.startsWith('https://') ? f.web.replace(/\/$/, '') : '',
      brendonResource: Number(f.brendonResource) || 0,
      brendonRole: Number(f.brendonRole) || undefined,
      ticketCategory: Number(f.ticketCategory) || undefined,
      supportCc: typeof f.supportCc === 'string' ? f.supportCc : '',
      ownDomains: strs(f.ownDomains),
      teams: f.teams === true,
      agent: { id, name: String(agent.name ?? id), role: String(agent.role ?? ''), topic: String(agent.topic ?? '') },
      brief: typeof f.brief === 'string' ? f.brief : '',
    })
  }
  const keys = new Set(franchises.map((f) => f.key))
  const routes: Record<string, string> = {}
  for (const [k, v] of Object.entries((o.mailboxRoutes ?? {}) as Record<string, unknown>)) {
    if (KEY_RE.test(k) && typeof v === 'string' && keys.has(v)) routes[k] = v
  }
  const pick = (v: unknown) => (typeof v === 'string' && keys.has(v) ? v : null)
  return {
    franchises, self: strs(o.self), mailboxRoutes: routes,
    defaultFranchise: pick(o.defaultFranchise), teamsFranchise: pick(o.teamsFranchise), skipDomains: strs(o.skipDomains),
  }
}

export function workConf(): WorkConf {
  let mtime = 0
  try {
    mtime = statSync(FILE).mtimeMs
  } catch {
    if (!warned) { console.warn(`[agents] no ${FILE}: no franchises, so no triage agents`); warned = true }
    cache = null
    return EMPTY
  }
  if (cache && cache.mtime === mtime) return cache.conf
  try {
    cache = { mtime, conf: parse(JSON.parse(readFileSync(FILE, 'utf8'))) }
  } catch (e) {
    console.error(`[agents] ${FILE} is not valid JSON:`, (e as Error).message)
    cache = { mtime, conf: EMPTY }
  }
  return cache.conf
}

export const franchiseKeys = (): string[] => workConf().franchises.map((f) => f.key)

export function franchiseConf(key: string | null | undefined): FranchiseConf | null {
  if (!key) return null
  return workConf().franchises.find((f) => f.key === key) ?? null
}

export function triageAgentId(key: string): string | null {
  return franchiseConf(key)?.agent.id ?? null
}
