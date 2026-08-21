import { Router } from 'express'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { promises as fs, createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import path from 'node:path'

// GET /api/workspaces — one merged board of every Claude session across the
// tailnet: thor publishes a JSON snapshot into bifrost (SMB from its side,
// a local path from ours) and odin's own live sessions are read from ps here.
// This is ADDITIVE. /api/sessions keeps its own shape and its own consumers.

const exec = promisify(execFile)
const router = Router()

// Overridable so the route can be exercised against a sample file without
// touching the real board.
const THOR_BOARD_FILE = process.env.WORKSPACES_THOR_FILE
  || '/home/brendon/bifrost/session-board/thor.json'

// thor's collector runs on a short cycle; anything older than this is not a
// live view of that machine any more.
const STALE_MS = 150_000
// Hard ceiling on how much of a file written by another process we will fan
// out to clients. thor has ~40 live sessions on a bad day, so 500 is slack
// with a bound.
const MAX_SESSIONS = 500
const MAX_LABEL_CHARS = 200
// Counting lines means reading the whole transcript. The largest one seen is
// 6.5 MB, and this route is polled, so only count when it is cheap and report
// null instead of guessing.
const MESSAGE_COUNT_MAX_BYTES = 2_000_000
// A session whose transcript has not been appended to in this long is not
// doing anything, but its process is still up.
const ODIN_ACTIVE_MS = 30_000
// Below this many sessions a drop to zero is ordinary (Brendon closed his one
// window), not a producer that lost its data source.
const SUSPICIOUS_FLOOR = 3

const PROJECTS_DIR = path.join(homedir(), '.claude', 'projects')

const UUID_RE = /^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/
// A cwd is echoed back to clients and pasted into a resume command, so refuse
// the characters that would let a writer of thor.json break out of either.
const UNSAFE_CWD_RE = /["'`;\r\n$|&<>]/
// Client work and the separate Org C business never leave the machine
// they run on. thor's collector already redacts these, but it is not the
// trust boundary: anything running as brendon can write thor.json, so the
// rule is enforced again here on the cwd we actually publish.
const REDACT_RES: RegExp[] = [
  /^C:\\Users\\Brendon\\Org A\\/i,
  /^C:\\Users\\Brendon\\Org B\\/i,
  /^C:\\Users\\Brendon\\Org C\\/i,
  // Same folders reached by any other route (UNC, a mapped drive, odin-side
  // copies): match on the client name itself, not just the drive-letter path.
  /Org A/i,
  /Org B/i,
  /Org C/i,
]

const AREAS = ['personal', 'server', 'work', 'org-c'] as const
const STATES = ['running', 'asking', 'idle', 'closed'] as const
type Area = (typeof AREAS)[number]
type SessionState = (typeof STATES)[number]
type HostHealth = 'healthy' | 'stale' | 'unhealthy' | 'suspicious'

// The frozen contract, plus `host` so a merged list stays attributable.
type WorkspaceSession = {
  host: string
  sessionId: string | null
  pid: number | null
  name: string | null
  title: string | null
  cwd: string
  project: string | null
  area: Area
  state: SessionState
  lastActivityUtc: string | null
  startedAtUtc: string | null
  transcriptBytes: number | null
  messageCount: number | null
  resumeCommand: string | null
  redacted: boolean
}

type HostStatus = {
  host: string
  health: HostHealth
  ageSeconds: number | null
  generatedAt: string | null
  producerOk: boolean
  sessionCount: number
  claudeVersion: string | null
  lastBootUtc: string | null
  servedFromCache: boolean
  droppedRecords: number
  // Well-formed records the payload cap left behind. Counted apart from
  // droppedRecords so the UI never calls a healthy older session "malformed":
  // thor publishes every session it can see (~3000), this route serves the
  // newest MAX_SESSIONS of them, and that is a cap, not a fault.
  truncatedRecords: number
  error: string | null
}

type WorkspacesResponse = {
  generatedAt: string
  hosts: HostStatus[]
  sessions: WorkspaceSession[]
}

// ---------------------------------------------------------------- validation

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function cleanLabel(v: unknown): string | null {
  if (typeof v !== 'string') return null
  // Control characters in a label would corrupt any terminal that prints the
  // board, so they are stripped rather than escaped.
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  if (!s) return null
  return s.length > MAX_LABEL_CHARS ? s.slice(0, MAX_LABEL_CHARS) : s
}

function isoOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const ms = Date.parse(v)
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString()
}

function nonNegativeOrNull(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null
  return v
}

function shouldRedact(cwd: string): boolean {
  return REDACT_RES.some((re) => re.test(cwd))
}

function leafFolder(cwd: string): string | null {
  // thor sends Windows paths; path.basename here is POSIX and would return the
  // whole string, so split on both separators.
  const parts = cwd.split(/[\\/]+/).filter(Boolean)
  const last = parts[parts.length - 1]
  if (!last) return null
  // "C:" alone is a drive root, not a project.
  return /^[A-Za-z]:$/.test(last) ? null : last
}

function windowsResumeCommand(cwd: string, sessionId: string | null): string | null {
  if (!sessionId) return null
  return `cd "${cwd}"; claude -r ${sessionId}`
}

function posixResumeCommand(cwd: string, sessionId: string | null): string | null {
  if (!sessionId) return null
  return `cd '${cwd}' && claude -r ${sessionId}`
}

// Drops a record instead of rejecting the file: one bad row from a partially
// written snapshot must not blank the whole board.
function validateThorSession(raw: unknown): WorkspaceSession | null {
  if (!isPlainObject(raw)) return null

  const sessionId = raw.sessionId === null || raw.sessionId === undefined
    ? null
    : typeof raw.sessionId === 'string' && UUID_RE.test(raw.sessionId) ? raw.sessionId : undefined
  if (sessionId === undefined) return null

  if (typeof raw.cwd !== 'string' || !raw.cwd.trim()) return null
  const cwd = raw.cwd
  if (cwd.length > 512 || UNSAFE_CWD_RE.test(cwd)) return null

  const state = typeof raw.state === 'string' && (STATES as readonly string[]).includes(raw.state)
    ? raw.state as SessionState
    : null
  if (!state) return null

  const area = typeof raw.area === 'string' && (AREAS as readonly string[]).includes(raw.area)
    ? raw.area as Area
    : null
  if (!area) return null

  let pid: number | null = null
  if (raw.pid !== null && raw.pid !== undefined) {
    if (typeof raw.pid !== 'number' || !Number.isInteger(raw.pid) || raw.pid <= 0) return null
    pid = raw.pid
  }

  const redacted = shouldRedact(cwd) || raw.redacted === true
  // The redaction rule allows exactly this much of a client session to leave
  // the machine: the leaf folder, area, state, timestamps and the id. So the
  // path itself is truncated to its leaf, the incoming project label is not
  // trusted (it could carry a client name), and no resume command is offered
  // because building one would mean publishing the full path.
  const publishedCwd = redacted ? (leafFolder(cwd) ?? 'redacted') : cwd
  const project = redacted
    ? leafFolder(cwd)
    : typeof raw.project === 'string' && raw.project.trim()
      ? cleanLabel(raw.project)
      : leafFolder(cwd)

  return {
    host: 'thor',
    sessionId,
    pid,
    name: redacted ? null : cleanLabel(raw.name),
    title: redacted ? null : cleanLabel(raw.title),
    cwd: publishedCwd,
    project,
    area,
    state,
    lastActivityUtc: isoOrNull(raw.lastActivityUtc),
    startedAtUtc: isoOrNull(raw.startedAtUtc),
    transcriptBytes: nonNegativeOrNull(raw.transcriptBytes),
    messageCount: nonNegativeOrNull(raw.messageCount),
    // Rebuilt, never echoed: the incoming string is attacker-controlled and
    // this one is meant to be copy-pasted into a shell.
    resumeCommand: redacted ? null : windowsResumeCommand(cwd, sessionId),
    redacted,
  }
}

// ------------------------------------------------------------- thor snapshot

type ThorRead = {
  sessions: WorkspaceSession[]
  producerOk: boolean
  producerError: string | null
  generatedAt: string | null
  claudeVersion: string | null
  lastBootUtc: string | null
  mtimeMs: number
  droppedRecords: number
  truncatedRecords: number
}

// Last successfully parsed snapshot. When the file goes missing or turns into
// garbage mid-write we keep serving this and report how old it really is,
// which is more useful than a 500 and honest about what the client is seeing.
let lastGoodThor: ThorRead | null = null
// Previous published session count, for the "suspicious" health state.
let lastThorCount: number | null = null

async function readThorBoard(): Promise<ThorRead> {
  const stat = await fs.stat(THOR_BOARD_FILE)
  const raw = await fs.readFile(THOR_BOARD_FILE, 'utf8')

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`unparseable json: ${(err as Error).message}`)
  }
  if (!isPlainObject(parsed)) throw new Error('root is not an object')

  const incoming = Array.isArray(parsed.sessions) ? parsed.sessions : []
  const capped = incoming.slice(0, MAX_SESSIONS)
  // thor sorts asking > running > idle > closed, newest first, so the cap keeps
  // the rows that matter and only sheds old closed sessions.
  const truncated = incoming.length - capped.length
  let dropped = 0

  const sessions: WorkspaceSession[] = []
  const seen = new Set<string>()
  for (const rec of capped) {
    const session = validateThorSession(rec)
    if (!session) { dropped++; continue }
    // A duplicated sessionId would render as two cards for one window.
    const key = session.sessionId ?? `pid:${session.pid ?? 'none'}:${session.cwd}`
    if (seen.has(key)) { dropped++; continue }
    seen.add(key)
    sessions.push(session)
  }

  return {
    sessions,
    producerOk: parsed.producerOk !== false,
    producerError: typeof parsed.producerError === 'string' ? cleanLabel(parsed.producerError) : null,
    generatedAt: isoOrNull(parsed.generatedAt),
    claudeVersion: typeof parsed.claudeVersion === 'string' ? cleanLabel(parsed.claudeVersion) : null,
    lastBootUtc: isoOrNull(parsed.lastBootUtc),
    mtimeMs: stat.mtimeMs,
    droppedRecords: dropped,
    truncatedRecords: truncated,
  }
}

// Precedence is deliberate: "suspicious" first because a producer that lost
// its data source still writes a fresh, well-formed, empty file and would
// otherwise read as healthy. Then unhealthy (the producer told us, or the
// file is unreadable), then stale, then healthy.
function classifyHealth(read: ThorRead | null, readError: string | null, ageMs: number): HostHealth {
  if (!read) return 'unhealthy'
  if (lastThorCount !== null && lastThorCount >= SUSPICIOUS_FLOOR && read.sessions.length === 0) {
    return 'suspicious'
  }
  if (readError || !read.producerOk) return 'unhealthy'
  if (ageMs > STALE_MS) return 'stale'
  return 'healthy'
}

async function collectThor(): Promise<{ status: HostStatus; sessions: WorkspaceSession[] }> {
  let read: ThorRead | null = null
  let readError: string | null = null
  try {
    read = await readThorBoard()
    lastGoodThor = read
  } catch (err) {
    readError = (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'board file missing'
      : (err as Error).message
    read = lastGoodThor
  }

  const served = read
  const ageMs = served ? Date.now() - served.mtimeMs : Number.POSITIVE_INFINITY
  const health = classifyHealth(served, readError, ageMs)
  if (served && !readError) lastThorCount = served.sessions.length

  const status: HostStatus = {
    host: 'thor',
    health,
    ageSeconds: served ? Math.round(ageMs / 1000) : null,
    generatedAt: served?.generatedAt ?? null,
    producerOk: served ? served.producerOk : false,
    sessionCount: served?.sessions.length ?? 0,
    claudeVersion: served?.claudeVersion ?? null,
    lastBootUtc: served?.lastBootUtc ?? null,
    servedFromCache: Boolean(readError && served),
    droppedRecords: served?.droppedRecords ?? 0,
    truncatedRecords: served?.truncatedRecords ?? 0,
    error: readError ?? served?.producerError ?? null,
  }
  return { status, sessions: served?.sessions ?? [] }
}

// -------------------------------------------------------------- odin's own

// Mirrors the routing thor's collector applies, translated to odin's layout.
// First match wins.
const ODIN_AREA_RULES: Array<{ area: Area; re: RegExp }> = [
  { area: 'org-c', re: /^\/home\/brendon\/(org-c|halopsa-mcp|ninjaone-mcp)(\/|$)/i },
  { area: 'work', re: /^\/home\/brendon\/(msp-platform|work)(\/|$)/i },
  { area: 'personal', re: /^\/home\/brendon\/(side-proj|trade-bot|trading|proj-c|game|slop-factory|docs)(\/|$)/ },
  { area: 'server', re: /^\/home\/brendon\/(valkyrie|infra|maintenance|memory|skills|ThorRGB|crashguesser|wallpaperengine|home-ai-install|bifrost)(\/|$)/i },
]

function odinArea(cwd: string): Area {
  for (const rule of ODIN_AREA_RULES) if (rule.re.test(cwd)) return rule.area
  // Everything else on odin is the server itself.
  return 'server'
}

async function findSessionFile(sessionId: string): Promise<string | null> {
  try {
    const dirs = await fs.readdir(PROJECTS_DIR)
    for (const d of dirs) {
      const candidate = path.join(PROJECTS_DIR, d, `${sessionId}.jsonl`)
      try {
        await fs.access(candidate)
        return candidate
      } catch { /* try next */ }
    }
  } catch { /* projects dir missing */ }
  return null
}

type TranscriptFacts = {
  cwd: string | null
  lastActivityMs: number | null
  bytes: number | null
  messageCount: number | null
}

async function readTranscriptFacts(file: string): Promise<TranscriptFacts> {
  const empty: TranscriptFacts = { cwd: null, lastActivityMs: null, bytes: null, messageCount: null }
  try {
    const stat = await fs.stat(file)
    // Tail only: the same 32 KB window /api/sessions uses, which is enough to
    // land on a line carrying cwd and a timestamp.
    const start = Math.max(0, stat.size - 32_768)
    const tail = createReadStream(file, { start, encoding: 'utf8' })
    let last: { cwd?: string; timestamp?: string } | null = null
    for await (const line of createInterface({ input: tail, crlfDelay: Infinity })) {
      if (!line.includes('"cwd"')) continue
      try {
        const obj = JSON.parse(line) as { cwd?: string; timestamp?: string }
        if (obj.cwd) last = obj
      } catch { /* skip malformed */ }
    }

    let messageCount: number | null = null
    if (stat.size <= MESSAGE_COUNT_MAX_BYTES) {
      let n = 0
      const whole = createReadStream(file, { encoding: 'utf8' })
      for await (const line of createInterface({ input: whole, crlfDelay: Infinity })) {
        if (line.trim()) n++
      }
      messageCount = n
    }

    const ts = last?.timestamp ? Date.parse(last.timestamp) : NaN
    return {
      cwd: last?.cwd ?? null,
      lastActivityMs: Number.isFinite(ts) ? ts : null,
      bytes: stat.size,
      messageCount,
    }
  } catch {
    return empty
  }
}

async function collectOdin(): Promise<{ status: HostStatus; sessions: WorkspaceSession[] }> {
  const now = new Date()
  try {
    // Same detection as /api/sessions: a resumed claude process on this box.
    const { stdout } = await exec('ps', ['-eo', 'pid,pcpu,rss,etime,args'], { timeout: 5_000 })
    const rows = stdout.trim().split('\n').slice(1)
      .map((l) => l.trim())
      .filter((l) => l.includes('--resume') && l.includes('--model') && l.includes('claude'))
      .map((l) => {
        const [pid, , , , ...rest] = l.split(/\s+/)
        const args = rest.join(' ')
        const sessionMatch = args.match(/--resume\s+(\S+)/)
        const id = sessionMatch?.[1] ?? null
        return {
          pid: Number(pid),
          sessionId: id && UUID_RE.test(id) ? id : null,
        }
      })
      .filter((r) => Number.isInteger(r.pid) && r.pid > 0)

    const sessions: WorkspaceSession[] = []
    for (const row of rows) {
      const file = row.sessionId ? await findSessionFile(row.sessionId) : null
      const facts = file ? await readTranscriptFacts(file) : null
      const cwd = facts?.cwd ?? null
      // No cwd means no transcript we can attribute; publishing it would give
      // a card with no identity and no safe resume command.
      if (!cwd || UNSAFE_CWD_RE.test(cwd)) continue
      const redacted = shouldRedact(cwd)
      const publishedCwd = redacted ? (leafFolder(cwd) ?? 'redacted') : cwd
      const lastMs = facts?.lastActivityMs ?? null
      const idle = lastMs === null || Date.now() - lastMs > ODIN_ACTIVE_MS
      sessions.push({
        host: 'odin',
        sessionId: row.sessionId,
        pid: row.pid,
        // odin has no pid registry and no idle-prompt signal, so there is no
        // name to report and "asking" is never claimed here.
        name: null,
        title: null,
        cwd: publishedCwd,
        project: leafFolder(cwd),
        area: odinArea(cwd),
        state: idle ? 'idle' : 'running',
        lastActivityUtc: lastMs === null ? null : new Date(lastMs).toISOString(),
        startedAtUtc: null,
        transcriptBytes: facts?.bytes ?? null,
        messageCount: facts?.messageCount ?? null,
        resumeCommand: redacted ? null : posixResumeCommand(cwd, row.sessionId),
        redacted,
      })
    }

    return {
      status: {
        host: 'odin',
        health: 'healthy',
        ageSeconds: 0,
        generatedAt: now.toISOString(),
        producerOk: true,
        sessionCount: sessions.length,
        claudeVersion: null,
        lastBootUtc: null,
        servedFromCache: false,
        droppedRecords: 0,
        truncatedRecords: 0,
        error: null,
      },
      sessions,
    }
  } catch (err) {
    // odin failing to enumerate itself must not take thor's half of the board
    // down with it.
    console.error('[workspaces] failed to enumerate odin sessions:', err)
    return {
      status: {
        host: 'odin',
        health: 'unhealthy',
        ageSeconds: 0,
        generatedAt: now.toISOString(),
        producerOk: false,
        sessionCount: 0,
        claudeVersion: null,
        lastBootUtc: null,
        servedFromCache: false,
        droppedRecords: 0,
        truncatedRecords: 0,
        error: (err as Error).message,
      },
      sessions: [],
    }
  }
}

// ------------------------------------------------------------------- route

const STATE_ORDER: Record<SessionState, number> = { asking: 0, running: 1, idle: 2, closed: 3 }

router.get('/workspaces', async (_req, res) => {
  const [thor, odin] = await Promise.all([collectThor(), collectOdin()])
  const sessions = [...thor.sessions, ...odin.sessions].sort((a, b) => {
    const byState = STATE_ORDER[a.state] - STATE_ORDER[b.state]
    if (byState !== 0) return byState
    const at = a.lastActivityUtc ? Date.parse(a.lastActivityUtc) : 0
    const bt = b.lastActivityUtc ? Date.parse(b.lastActivityUtc) : 0
    return bt - at
  })

  const payload: WorkspacesResponse = {
    generatedAt: new Date().toISOString(),
    hosts: [thor.status, odin.status],
    sessions,
  }
  res.json(payload)
})

export default router
