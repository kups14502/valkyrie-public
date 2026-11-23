import { randomUUID } from 'node:crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { bump, getKv, setKv } from '../../agentsStore.js'
import { failRunsForTmux } from '../../projectsStore.js'
import { noteRavenStarted, ravenStartedIds } from '../../sessionOrigin.js'
import { paneLimitState } from '../../accountSwitchCore.js'
import type { LaunchTargetInfo } from '../../../routes/hostLaunch.js'
import { CLAUDE_EFFORTS, SESSION_NAME_RE, TARGET_RE, UUID_RE, type ClaudeEffort, type CreateOpts, type TermSession } from '../../../terminal/tmux.js'
import { mayBeBusy, paneBusy, screenBusy, screenWaiting } from '../../../terminal/paneState.js'
import type { TranscriptEntry } from '../../../terminal/transcript.js'
import { modelFor, modelKeys, ravenModels } from '../models.js'
import type { RavenToolCtx } from '../types.js'
import { io, onIoReset, type BoardRow } from './io.js'
import { noteRavenTouched } from './owned.js'
import { AUTO_CLOSE_MS, closesAt, getWatch, keepWatch, listWatches, removeWatch, startWatch, turnOpen, waitCounts, watchKey, type Watch } from './watch.js'
import { ago, clip, et, needBrendon, RavenToolError, toolRun } from './util.js'

// Brendon's Claude sessions, as Raven reaches them.
//
// A session Raven can TYPE into is a tmux pane on odin whose program is ssh to
// thor (terminal/tmux.ts), the same panes the phone terminal opens. A session
// running in a Windows Terminal window on thor is on the session board too,
// and Raven can read its transcript but never type into it.
//
// "Main terminals" are thor's launch targets marked phone and not project:
// Brendon's everyday Claude contexts (personal, work, the second work area).
// Raven keeps at most one pane per main target (kv raven:mains, target to
// pane), started the first time Raven needs it. Keys and labels always come
// from thor's own list, never from here.
//
// Typing is one line. Claude Code reads a burst of keys as a paste, and a
// newline inside a paste stays in the prompt, so a multi-line prompt is
// joined with spaces and the Enter goes on its own a moment later (typeLine).
// A line over 800 bytes goes as one bracketed paste: typed as keys, Claude
// kept only its end (terminal/tmux.ts typePlan).
//
// A model and an effort are claude's --model and --effort, so they apply to
// a pane Raven opens and never to one already running.

const MAINS_KEY = 'raven:mains'
const PROMPT_WAIT_MS = 45_000
const TEXT_MAX = 8_000
const TARGETS_TTL_MS = 10 * 60_000
const KEEP_DEFAULT_MIN = 60
const KEEP_MAX_MIN = 240
const AUTO_CLOSE_MIN = AUTO_CLOSE_MS / 60_000

export type RavenMain = { target: string; label: string; pane: string | null; state: 'working' | 'idle' | 'closed' | 'dead' }
export type WatchState = 'working' | 'idle' | 'closed'
/**
 * A watched session for the Watching card: `label` is the pane's (often the main target's name), `title` the job's name
 * from Raven's label when that says more than the pane label, `status` the first sentence of its newest answer when short. `state` is null when thor's board is not answering for a window on thor;
 * `lastAt` is its last activity (its newest transcript line, or when it closed).
 */
export type RavenWatch = { pane: string; label: string; sessionId: string; since: string; title?: string; status?: string; state: WatchState | null; lastAt: string }

type MainRec = { pane: string; label: string; sessionId: string; at: string }

function mainsMap(): Record<string, MainRec> {
  try {
    const v = JSON.parse(getKv(MAINS_KEY) ?? '{}') as Record<string, MainRec>
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

function setMain(target: string, rec: MainRec | null): void {
  const m = mainsMap()
  if (rec) m[target] = rec
  else delete m[target]
  setKv(MAINS_KEY, JSON.stringify(m))
  bump()
}

// ------------------------------------------------------------ targets ----

let targetsCache: { at: number; list: LaunchTargetInfo[] } | null = null
let targetsLoad: Promise<LaunchTargetInfo[] | null> | null = null
let targetsFailedAt = 0
let boardCache: { at: number; rows: BoardRow[] | null } | null = null
onIoReset(() => { targetsCache = null; targetsLoad = null; targetsFailedAt = 0; boardCache = null })

function loadTargets(): Promise<LaunchTargetInfo[] | null> {
  targetsLoad ??= io.launchTargets().catch(() => null).then((list) => {
    if (list) targetsCache = { at: io.now(), list }
    else targetsFailedAt = io.now()
    return list
  }).finally(() => { targetsLoad = null })
  return targetsLoad
}

/**
 * thor's launch targets: cached 10 minutes, a stale copy answering at once
 * while a fresh one loads. With nothing cached the caller waits at most
 * waitMs, and a thor that just failed is not asked again for a minute, so a
 * sleeping thor never holds up GET /api/raven.
 */
async function targets(waitMs = 9_000): Promise<LaunchTargetInfo[] | null> {
  if (targetsCache && io.now() - targetsCache.at < TARGETS_TTL_MS) return targetsCache.list
  if (!targetsCache && targetsFailedAt && io.now() - targetsFailedAt < 60_000) return null
  const load = loadTargets()
  if (targetsCache) return targetsCache.list
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<null>((r) => { timer = setTimeout(() => r(null), waitMs); timer.unref?.() })
  try {
    return await Promise.race([load, late])
  } finally {
    clearTimeout(timer)
  }
}

/** thor's session board, held 20 s: a name fragment is looked up there after the panes. */
async function board(): Promise<BoardRow[] | null> {
  if (boardCache && io.now() - boardCache.at < 20_000) return boardCache.rows
  const rows = await io.boardSessions().catch(() => null)
  boardCache = { at: io.now(), rows }
  return rows
}

const isMainTarget = (t: LaunchTargetInfo) => t.phone && !t.project && t.exists

/** The main targets, from thor's list; without thor, the ones Raven already opened. null when neither knows. */
export async function mainTargets(waitMs?: number): Promise<{ key: string; label: string }[] | null> {
  const list = await targets(waitMs)
  if (list) return list.filter(isMainTarget).map((t) => ({ key: t.key, label: t.label }))
  const known = Object.entries(mainsMap()).map(([key, r]) => ({ key, label: r.label.replace(/ \(main\)$/, '') }))
  return known.length ? known : null
}

// -------------------------------------------------------------- panes ----

// Working or not is the Desk's busy rule (terminal/paneState.ts), read through io.
const busy = (p: TermSession): Promise<boolean> => paneBusy(p, io.capture, io.now())

// Watching's rule: busy, or the transcript says its turn is still going and no
// prompt waits on him (watch.ts turnOpen: a tool runs, Claude is on a tool's
// result or between steps), or its turn ended with background work still out (a
// background shell, a monitor, an agent: paneState.ts screenWaiting), so a
// session waiting on a build reads Working. A wait counts only while the
// session had activity in the last 15 minutes or Raven holds it with
// session_keep (watch.ts waitCounts): a poll left running after the last
// answer reads Idle after that, never Working for good. A quiet pane's screen
// is read at most every 5 s; one that printed lately is read on every poll, as
// busy reads it.
const QUIET_READ_MS = 5_000
const quietReads = new Map<string, { at: number; waiting: boolean }>()

async function working(p: TermSession, w: Watch): Promise<boolean> {
  if (p.dead) return false
  const now = io.now()
  if (turnOpen(w, now) && !w.asking) return true
  for (const [name, r] of quietReads) if (now - r.at > 10 * 60_000) quietReads.delete(name)
  const counts = waitCounts(w, now)
  if (mayBeBusy(p, now)) {
    const screen = await io.capture(p.name)
    const waiting = screenWaiting(screen)
    quietReads.set(p.name, { at: now, waiting })
    return screenBusy(screen) || (waiting && counts)
  }
  if (!counts) return false
  const last = quietReads.get(p.name)
  if (last && now - last.at < QUIET_READ_MS) return last.waiting
  const waiting = screenWaiting(await io.capture(p.name))
  quietReads.set(p.name, { at: now, waiting })
  return waiting
}

function mainOf(pane: string): string | null {
  for (const [target, r] of Object.entries(mainsMap())) if (r.pane === pane) return target
  return null
}

type Resolved =
  | { kind: 'pane'; pane: TermSession }
  | { kind: 'main'; target: { key: string; label: string } }
  | { kind: 'board'; sessionId: string; title: string }

const boardRunning = (rows: BoardRow[] | null) => (rows ?? []).filter((r) => r.live === true && typeof r.sessionId === 'string' && UUID_RE.test(r.sessionId))
const boardTitle = (r: BoardRow) => String(r.title || r.project || String(r.sessionId).slice(0, 8))

/** session = a pane name, a main target key, a conversation id, or a unique fragment of a label or title. */
async function resolve(session: string, panes: TermSession[], allowBoard: boolean): Promise<Resolved> {
  const s = session.trim()
  if (!s) throw new RavenToolError('name a session: a pane name, a main target key, or part of its label')
  if (SESSION_NAME_RE.test(s)) {
    const p = panes.find((x) => x.name === s)
    if (!p) throw new RavenToolError(`no open pane ${s}`)
    return { kind: 'pane', pane: p }
  }
  const mains = await mainTargets()
  const main = mains?.find((t) => t.key === s.toLowerCase())
  if (main) {
    const rec = mainsMap()[main.key]
    const p = rec ? panes.find((x) => x.name === rec.pane && !x.dead) : undefined
    return p ? { kind: 'pane', pane: p } : { kind: 'main', target: main }
  }
  if (UUID_RE.test(s)) {
    const p = panes.find((x) => x.sessionId === s)
    if (p) return { kind: 'pane', pane: p }
    if (allowBoard) return { kind: 'board', sessionId: s, title: s.slice(0, 8) }
    throw new RavenToolError(`no pane runs conversation ${s}`)
  }
  const frag = s.toLowerCase()
  const hits = panes.filter((p) => p.label.toLowerCase().includes(frag) || p.target.toLowerCase() === frag)
  if (hits.length === 1) return { kind: 'pane', pane: hits[0] }
  if (hits.length > 1) throw new RavenToolError(`"${s}" matches ${hits.length} panes: ${hits.map((p) => `${p.name} (${p.label})`).join(', ')}. Use the pane name.`)
  if (allowBoard) {
    const rows = boardRunning(await board()).filter((r) => boardTitle(r).toLowerCase().includes(frag))
    if (rows.length === 1) {
      // a pane here runs on thor too, so thor's board lists it: the pane is the one Raven can type into and watch once
      const inPane = panes.find((p) => p.sessionId === rows[0].sessionId)
      return inPane ? { kind: 'pane', pane: inPane } : { kind: 'board', sessionId: String(rows[0].sessionId), title: boardTitle(rows[0]) }
    }
    if (rows.length > 1) throw new RavenToolError(`"${s}" matches ${rows.length} sessions on thor: ${rows.slice(0, 6).map((r) => `${boardTitle(r)} (${r.sessionId})`).join(', ')}. Use the session id.`)
  }
  throw new RavenToolError(`no session matches "${s}". sessions lists them.`)
}

/**
 * A pane Raven opened with session_start: its conversation is on Raven's record (lib/sessionOrigin.ts) and it is
 * not one of Brendon's main terminals, now or before. Raven may close these on its own.
 */
function ravenLaunched(p: TermSession): boolean {
  return !mainOf(p.name) && ravenOwnSession(p.sessionId)
}

/** A pane the auto-close may close (autoclose.ts): one Raven opened with session_start, never a main terminal or one he opened. */
export const isRavenJob = (p: TermSession): boolean => !p.dead && p.mode !== 'shell' && ravenLaunched(p)

/**
 * Closes a session Raven started, for good: off Watching (no "ended" line), its background shells and monitors and
 * then its Claude ended on thor, the pane killed, a project run in it failed, the conversation marked done on the
 * Desk. session_stop and the auto-close both close one this way. Killing the pane alone ends Claude but leaves what
 * it runs in the background on thor (Kill-Session.ps1), so thor goes first.
 */
export async function closeJob(p: TermSession): Promise<{ killed: boolean; markedDone: boolean }> {
  removeWatch(p.name)
  if (p.sessionId) removeWatch(watchKey('', p.sessionId))
  const onThor = p.sessionId ? await io.stopOnThor(p.sessionId).catch(() => 'failed' as const) : 'none'
  const killed = (await io.killPane(p.name).catch(() => false)) || onThor === 'stopped'
  if (!killed) return { killed, markedDone: false }
  // a project run in that pane never reports now, as when the page stops it (routes/terminal.ts)
  try { failRunsForTmux(p.name, 'stopped before it reported') } catch (e) { console.error('[raven-tools] runs for', p.name, words(e)) }
  const markedDone = p.sessionId ? await io.markDone([p.sessionId]).catch(() => false) : false
  return { killed, markedDone }
}

/** A conversation Raven started with session_start: on Raven's record and never a main terminal's. */
function ravenOwnSession(sessionId: string | undefined): boolean {
  if (!sessionId) return false
  if (Object.values(mainsMap()).some((r) => r.sessionId === sessionId)) return false
  return ravenStartedIds().has(sessionId)
}

type DoneTarget = { sessionId: string; label: string; pane?: TermSession }

/** session_done's session: what resolve finds, then a closed row on thor's board by its title. */
async function doneTarget(session: string): Promise<DoneTarget> {
  const panes = await io.listPanes()
  const r = await resolve(session, panes, true).catch((e: unknown) => e as Error)
  if (!(r instanceof Error)) {
    if (r.kind === 'main') throw new RavenToolError(`${r.target.label} has no main terminal open`)
    if (r.kind === 'board') return { sessionId: r.sessionId, label: r.title }
    if (!r.pane.sessionId) throw new RavenToolError(`${r.pane.label} (${r.pane.name}) runs no Claude conversation`)
    return { sessionId: r.pane.sessionId, label: r.pane.label, pane: r.pane }
  }
  const frag = session.trim().toLowerCase()
  if (!frag || !/^no session matches/.test(r.message)) throw r
  const rows = ((await board()) ?? []).filter((x) => typeof x.sessionId === 'string' && UUID_RE.test(x.sessionId)
    && x.disposition !== 'done' && boardTitle(x).toLowerCase().includes(frag))
  if (rows.length === 1) return { sessionId: String(rows[0].sessionId), label: boardTitle(rows[0]) }
  if (rows.length > 1) throw new RavenToolError(`"${session}" matches ${rows.length} sessions on thor: ${rows.slice(0, 6).map((x) => `${boardTitle(x)} (${x.sessionId})`).join(', ')}. Use the session id.`)
  throw r
}

const BOARD_ONLY = 'runs in a window on thor, not in a pane here: Raven can read it (session_read) and relay it (session_watch) but cannot type into it or stop it'

/** One line for typeLine: lines joined with spaces, control characters out. */
export function oneLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean).join(' ').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/ {2,}/g, ' ').trim()
}

/** A pane label as routes/terminal.ts cuts one: tmux lists panes one per line with \x1f between fields, so a label carries neither. */
export function paneLabel(label: string | undefined, fallback: string): string {
  return (oneLine(label ?? '') || oneLine(fallback) || 'session').slice(0, 60)
}

function checkText(text: string): string {
  const line = oneLine(text)
  if (!line) throw new RavenToolError('nothing to type')
  if (line.length > TEXT_MAX) throw new RavenToolError(`keep it under ${TEXT_MAX} characters`)
  // a leading ! is Claude Code's shell mode: the rest would run on thor as a command
  if (line.startsWith('!')) throw new RavenToolError('a line starting with ! runs a shell command on thor; Raven does not type those')
  return line
}

async function waitForPrompt(pane: string): Promise<'ready' | 'dead' | 'timeout'> {
  const until = io.now() + PROMPT_WAIT_MS
  for (;;) {
    const state = await io.paneState(pane)
    if (state === 'dead' || state === 'gone') return 'dead'
    const screen = await io.capturePrompt(pane)
    if (screen && paneLimitState(screen).promptFound) return 'ready'
    if (io.now() >= until) return 'timeout'
    await io.sleep(1_000)
  }
}

/** A pane Raven may type into now: at Claude's prompt, nothing half-typed. */
async function readyToType(p: TermSession): Promise<void> {
  if (p.dead) throw new RavenToolError(`${p.label} (${p.name}) has ended; start a new one`)
  if (p.mode === 'shell') throw new RavenToolError(`${p.label} (${p.name}) is a shell, not a Claude session; Raven types only into Claude`)
  if (await io.paneInMode(p.name)) await io.leaveMode(p.name)
  const v = paneLimitState((await io.capturePrompt(p.name)) ?? '')
  if (!v.promptFound) throw new RavenToolError(`${p.label} is not at Claude's prompt: a question, a permission prompt or a menu is open. Brendon can answer it at /m/ai/term/${p.name}. Nothing was typed.`)
  if (!v.promptEmpty) throw new RavenToolError(`${p.label} has text typed in its prompt, so Brendon is typing there. Nothing was typed.`)
}

/** Copies DM attachments to thor and answers their paths there. */
async function attach(ids: string[]): Promise<string[]> {
  const out: string[] = []
  for (const id of ids) {
    const f = io.ravenFile(id)
    if (!f) throw new RavenToolError(`no attachment ${id}`)
    try {
      out.push((await io.uploadToThor(f.file.name, await io.readFile(f.path))).path)
    } catch (e) {
      throw new RavenToolError(`could not copy ${f.file.name} to thor (${(e as Error).message}). Nothing was typed.`)
    }
  }
  return out
}

// tmux and thor speak in dashes; Raven reads plain words
const words = (e: unknown): string => String((e as Error)?.message ?? e).replace(/\s*\u2014\s*/g, ', ').slice(0, 300)

type Launch = { model?: string; effort?: ClaudeEffort }

/** session_start's model (a key of Raven's model list, or its id) and effort, as the new pane's claude gets them. */
export function launchPick(model: string | undefined, effort: ClaudeEffort | undefined): Launch {
  const out: Launch = {}
  const want = model?.trim().toLowerCase()
  if (want) {
    const hit = ravenModels().find((m) => m.key === want || m.id.toLowerCase() === want)
    if (!hit) throw new RavenToolError(`no model "${model}". Models: ${modelKeys().join(', ')}. Nothing was started.`)
    // the fallback while the CLI refuses the configured id (lib/raven/models.ts)
    out.model = modelFor(hit.key)
  }
  if (effort) out.effort = effort
  return out
}

const launchShown = (l: Launch) => ({ ...(l.model ? { model: l.model } : {}), ...(l.effort ? { effort: l.effort } : {}) })

function notRunning(l: Launch, label: string): void {
  if (l.model || l.effort) {
    throw new RavenToolError(`${label} is already running, and a model or an effort is set only when a session starts. Nothing was typed. Send without them, or start a new session.`)
  }
}

async function newPane(o: CreateOpts): Promise<string> {
  try {
    return await io.createPane(o)
  } catch (e) {
    throw new RavenToolError(`could not open a pane: ${words(e)}`)
  }
}

async function typeInto(pane: string, label: string, text: string): Promise<void> {
  try {
    await io.typeLine(pane, text)
  } catch (e) {
    throw new RavenToolError(`could not type into ${label} (${words(e)})`)
  }
}

async function openMain(t: { key: string; label: string }, launch: Launch = {}): Promise<{ pane: string; label: string; sessionId: string }> {
  const old = mainsMap()[t.key]
  if (old && (await io.paneState(old.pane)) === 'dead') await io.killPane(old.pane).catch(() => false)
  // the target's own name, the one Quick Start and the terminal lists show ("Personal", not "Personal (main)")
  const label = paneLabel(t.label, t.key)
  const sessionId = randomUUID()
  // on record before the pane opens, so the Desk's first poll already shows it as Raven's
  noteRavenStarted(sessionId, io.now())
  const pane = await newPane({ mode: 'new', host: 'thor', target: t.key, newId: sessionId, label, cols: 120, rows: 40, ...launch })
  setMain(t.key, { pane, label, sessionId, at: new Date(io.now()).toISOString() })
  return { pane, label, sessionId }
}

async function promptOrThrow(pane: string, label: string): Promise<void> {
  const ready = await waitForPrompt(pane)
  if (ready === 'dead') throw new RavenToolError(`${label} (${pane}) ended before Claude started: thor can be asleep or refusing the login. Nothing was typed.`)
  if (ready === 'timeout') throw new RavenToolError(`${label} started (pane ${pane}) but Claude's prompt did not show within ${PROMPT_WAIT_MS / 1000} s. Nothing was typed; Brendon can look at /m/ai/term/${pane}.`)
}

const withFiles = (text: string, paths: string[]) => (paths.length ? `${text} (attached, on thor: ${paths.join(', ')})` : text)

/** thor's launch target by key, checked as session_start checks it. Answers its label. */
export async function checkTarget(target: string): Promise<{ key: string; label: string }> {
  const key = target.trim().toLowerCase()
  const list = await targets()
  const t = list?.find((x) => x.key === key)
  if (list && !t) throw new RavenToolError(`thor has no launch target "${target}". Targets: ${list.filter((x) => x.exists).map((x) => x.key).join(', ')}`)
  if (!list && !TARGET_RE.test(key)) throw new RavenToolError('target must be a launch-target key')
  if (t && !t.exists) throw new RavenToolError(`the folder for "${key}" does not exist on thor`)
  return { key, label: t?.label || key }
}

/**
 * A job: a new Claude session on thor in a launch target, the prompt typed once its prompt shows, watched by Raven
 * (every answer wakes Raven, followUp says what to do with it). session_start's non-main path, and what a feature
 * hands work to (a feature agent's work order). Throws a RavenToolError with plain words.
 */
export async function startJob(o: { target: string; prompt: string; label?: string; followUp?: string; launch?: Launch }): Promise<{ pane: string; label: string; sessionId: string }> {
  const text = checkText(o.prompt)
  const t = await checkTarget(o.target)
  const label = paneLabel(o.label, t.label)
  const title = o.label ? oneLine(o.label).slice(0, 60) : undefined
  const sessionId = randomUUID()
  noteRavenStarted(sessionId, io.now())
  const pane = await newPane({ mode: 'new', host: 'thor', target: t.key, newId: sessionId, label, cols: 120, rows: 40, ...(o.launch ?? {}) })
  await startWatch({ pane, label, sessionId, followUp: o.followUp, fresh: true, title, job: true })
  await promptOrThrow(pane, label)
  noteRavenTouched(sessionId)
  await typeInto(pane, label, text)
  return { pane, label, sessionId }
}

// ------------------------------------------------------- for the run loop ----

async function mainsNow(waitMs: number): Promise<{ known: boolean; mains: RavenMain[]; panes: TermSession[] }> {
  const [targets, panes] = await Promise.all([mainTargets(waitMs), io.listPanes().catch(() => [] as TermSession[])])
  const map = mainsMap()
  const mains: RavenMain[] = await Promise.all((targets ?? []).map(async (t): Promise<RavenMain> => {
    const rec = map[t.key]
    const p = rec ? panes.find((x) => x.name === rec.pane) : undefined
    if (!p) return { target: t.key, label: t.label, pane: null, state: 'closed' }
    if (p.dead) return { target: t.key, label: t.label, pane: p.name, state: 'dead' }
    return { target: t.key, label: t.label, pane: p.name, state: (await busy(p)) ? 'working' : 'idle' }
  }))
  return { known: targets !== null, mains, panes }
}

/** A thor window's state from the board: null when there is no copy of the board, closed when it is off the list. */
function boardState(rows: BoardRow[] | null, sessionId: string): WatchState | null {
  if (!rows) return null
  const r = rows.find((x) => x.sessionId === sessionId)
  if (!r || r.live !== true) return 'closed'
  return r.activity === 'working' ? 'working' : 'idle'
}

const boardAt = (rows: BoardRow[] | null, sessionId: string): number => {
  const r = rows?.find((x) => x.sessionId === sessionId)
  const at = r?.lastActivityUtc ? Date.parse(String(r.lastActivityUtc)) : NaN
  return Number.isFinite(at) ? at : 0
}

/**
 * Main terminals and watched sessions for GET /api/raven, the watches with their state, last activity and current
 * job. A closed session is not listed: Watching shows the working and idle ones only. Waits on thor 2.5 s at most, and not at all for a minute after it failed.
 */
export async function sessionsState(): Promise<{ mains: RavenMain[]; watching: RavenWatch[] }> {
  const { mains, panes } = await mainsNow(2_500)
  const rows = io.boardCached()
  const mainState = new Map(mains.filter((m) => m.pane).map((m) => [m.pane!, m.state]))
  // Raven's label for the job, never a prompt, an answer or Claude's own title (watch.ts)
  const titleOf = (w: Watch): string | undefined => {
    const t = w.title ?? ''
    return t && t.toLowerCase() !== w.label.trim().toLowerCase() ? t : undefined
  }
  const card = (w: Watch, state: WatchState | null, at: number): RavenWatch => {
    const title = titleOf(w)
    const status = w.status ?? ''
    return { pane: w.pane, label: w.label, sessionId: w.sessionId, since: w.since, ...(title ? { title } : {}), ...(status ? { status } : {}), state, lastAt: new Date(at).toISOString() }
  }
  const live = listWatches()
  const watching = await Promise.all(live.map(async (w): Promise<RavenWatch> => {
    let state: WatchState | null
    if (!w.pane) state = boardState(rows, w.sessionId)
    else {
      const m = mainState.get(w.pane)
      const p = panes.find((x) => x.name === w.pane)
      state = m === 'working' ? m : !p || p.dead ? 'closed' : (await working(p, w)) ? 'working' : 'idle'
    }
    const at = Math.max(w.lastSeenAt || 0, boardAt(rows, w.sessionId)) || Date.parse(w.lastActivityAt)
    return card(w, state, at)
  }))
  return { mains, watching: watching.filter((w) => w.state !== 'closed') }
}

/** Conversation id to its title, from thor's board as last read (never waits); empty when thor has not answered lately. */
export function sessionTitles(): Map<string, string> {
  const out = new Map<string, string>()
  for (const r of io.boardCached() ?? []) {
    const id = typeof r.sessionId === 'string' ? r.sessionId : ''
    const title = typeof r.title === 'string' ? oneLine(r.title).slice(0, 120) : ''
    if (id && title) out.set(id, title)
  }
  return out
}

/** A session's own title when it says more than its pane label, else undefined. */
export function titleFor(titles: Map<string, string>, sessionId: string | undefined, label: string): string | undefined {
  const t = sessionId ? titles.get(sessionId) : undefined
  return t && t.toLowerCase() !== label.trim().toLowerCase() ? t : undefined
}

/** A job's part of its snapshot line: Raven's to close, and when it closes on its own. */
function jobLine(w: Watch): string {
  if (!w.job) return ''
  const at = closesAt(w)
  const kept = (w.keepUntil ?? 0) > io.now() ? `, kept open until ${et(w.keepUntil!)}` : ''
  return `, a job you started (session_stop it once it reports the job done)${kept}${at !== null ? `, closes on its own at ${et(at)}` : ''}`
}

/** Plain lines for Raven's prompt: main terminals, watched sessions, other panes. */
export async function sessionsSnapshot(): Promise<string> {
  // the run loop gives the whole snapshot 5 s (lib/raven/run.ts): thor gets 4 of them
  const { known, mains, panes } = await mainsNow(4_000)
  const lines: string[] = []
  if (!known) lines.push('Main terminals: unknown (thor\'s launcher is not answering).')
  else {
    lines.push('Main terminals (Brendon\'s Claude contexts on thor; session_send to the target key types into them):')
    for (const m of mains) {
      lines.push(`- ${m.label} (target ${m.target}): ${m.pane ? `${m.state}, pane ${m.pane}` : 'no pane yet (session_send starts one)'}`)
    }
  }
  const all = listWatches()
  if (all.length) {
    lines.push('Watched sessions (everything they write comes to you; he sees only what you tell him):')
    for (const w of all) {
      lines.push(`- ${w.label}${w.pane ? ` (pane ${w.pane})` : ' (window on thor)'}: ${w.title ? `on "${clip(w.title, 100)}", ` : ''}since ${et(w.since)}, last activity ${ago(io.now() - Date.parse(w.lastActivityAt))} ago${w.followUp ? `, follow-up: ${clip(w.followUp, 200)}` : ''}${jobLine(w)}`)
    }
  } else {
    lines.push('Watched sessions: none.')
  }
  const mainPanes = new Set(mains.map((m) => m.pane).filter(Boolean))
  const others = panes.filter((p) => !mainPanes.has(p.name))
  if (others.length) lines.push(`Other panes: ${others.map((p) => `${p.label} (${p.name}${p.dead ? ', ended' : ''})`).join(', ')}.`)
  return lines.join('\n')
}

// --------------------------------------------------------------- tools ----

const userOrClaude = (e: TranscriptEntry) => (e.kind === 'user' || e.kind === 'assistant') && Boolean(e.text?.trim())

export function registerSessionTools(server: McpServer, ctx: RavenToolCtx): void {
  server.registerTool('main_terminals', {
    description: "Brendon's main terminals: one Claude pane per everyday context on thor (target key, label, state working/idle/closed/dead, pane). "
      + 'session_send to a target key types into it and starts the pane when there is none.',
    inputSchema: {},
  }, () => toolRun(async () => {
    const { known, mains } = await mainsNow(9_000)
    if (!known) return "thor's launcher is not answering, so the main terminals are unknown."
    return mains.map((m) => ({ ...m, watched: m.pane ? Boolean(getWatch(m.pane)) : false, open: m.pane ? `/m/ai/term/${m.pane}` : undefined }))
  }))

  server.registerTool('sessions', {
    description: 'Open Claude sessions: panes here (Raven can type into these) and the sessions running in windows on thor (read-only for Raven). '
      + 'idle is how long since the pane printed anything.',
    inputSchema: {},
  }, () => toolRun(async () => {
    const [panes, board] = await Promise.all([io.listPanes(), io.boardSessions()])
    const now = io.now()
    const inPane = new Set(panes.map((p) => p.sessionId).filter(Boolean))
    return {
      panes: panes.map((p) => ({
        pane: p.name, label: p.label, target: p.target, sessionId: p.sessionId || undefined, idle: ago(now - p.activityAt),
        host: p.host === 'thor' ? undefined : p.host, shell: p.mode === 'shell' || undefined,
        dead: p.dead || undefined, main: mainOf(p.name) ?? undefined, watched: Boolean(getWatch(p.name)) || undefined, typeable: !p.dead && p.mode !== 'shell',
      })),
      thor: board === null
        ? "thor's session list is not answering"
        : boardRunning(board).filter((r) => !inPane.has(String(r.sessionId))).map((r) => ({
          title: boardTitle(r), sessionId: r.sessionId, area: r.area, activity: r.activity, lastActivity: et(String(r.lastActivityUtc ?? '')),
          watched: Boolean(getWatch(watchKey('', String(r.sessionId)))) || undefined, typeable: false,
        })),
    }
  }))

  server.registerTool('session_start', {
    description: 'Start a new Claude session on thor in a launch target and type the prompt into it once its prompt shows (up to 45 s). '
      + 'main: true makes it that target\'s main terminal (if one is open, the prompt goes there instead). Everything it writes comes to you '
      + '(not to Brendon) unless watch is false; followUp is what you do with its next answer (you get woken with it). label names the job: the pane\'s name, '
      + 'and the title on Brendon\'s Watching card. '
      + `model (${modelKeys().join(', ')}) and effort (${CLAUDE_EFFORTS.join(', ')}) are what its Claude starts with; without them it starts on `
      + 'Brendon\'s defaults. They apply only to a session this starts: refused when the main terminal is already open. Only when Brendon\'s message asks. '
      + 'A session this starts (not main) is a job: while you watch it, every answer of it wakes you, and in the same run an answer reports its job done you must '
      + `session_stop it, which marks it done. One that stays quiet ${AUTO_CLOSE_MIN} minutes after an answer is closed and marked done on its own `
      + 'unless you session_keep it while it waits on something long.',
    inputSchema: {
      target: z.string().max(32), prompt: z.string().min(1).max(TEXT_MAX), label: z.string().max(60).optional(),
      watch: z.boolean().optional(), followUp: z.string().max(1000).optional(), main: z.boolean().optional(),
      model: z.string().max(80).optional(), effort: z.enum(CLAUDE_EFFORTS).optional(),
    },
  }, (a) => toolRun(async () => {
    needBrendon(ctx, 'Starting a session')
    const text = checkText(a.prompt)
    const launch = launchPick(a.model, a.effort)
    const key = a.target.trim().toLowerCase()
    const list = await targets()
    const t = list?.find((x) => x.key === key)
    if (list && !t) throw new RavenToolError(`thor has no launch target "${a.target}". Targets: ${list.filter((x) => x.exists).map((x) => x.key).join(', ')}`)
    if (!list && !TARGET_RE.test(key)) throw new RavenToolError('target must be a launch-target key')
    if (t && !t.exists) throw new RavenToolError(`the folder for "${key}" does not exist on thor`)
    const watch = a.watch !== false || Boolean(a.followUp)
    // the job's name on the Watching card: Raven's label only, never the prompt
    const title = a.label ? oneLine(a.label).slice(0, 60) : undefined
    if (a.main) {
      if (t && !isMainTarget(t)) throw new RavenToolError(`"${key}" is not one of the main terminals`)
      const rec = mainsMap()[key]
      const live = rec ? (await io.listPanes()).find((p) => p.name === rec.pane && !p.dead) : undefined
      if (live) {
        notRunning(launch, `${live.label}, the main terminal,`)
        await readyToType(live)
        if (watch) await startWatch({ pane: live.name, label: live.label, sessionId: live.sessionId, followUp: a.followUp, title })
        noteRavenTouched(live.sessionId)
        await typeInto(live.name, live.label, text)
        ctx.acted()
        return { pane: live.name, label: live.label, note: 'the main terminal was already open, so the prompt went there', watching: watch, open: `/m/ai/term/${live.name}` }
      }
      const opened = await openMain({ key, label: t?.label ?? key }, launch)
      ctx.acted()
      if (watch) await startWatch({ pane: opened.pane, label: opened.label, sessionId: opened.sessionId, followUp: a.followUp, fresh: true, title })
      await promptOrThrow(opened.pane, opened.label)
      noteRavenTouched(opened.sessionId)
      await typeInto(opened.pane, opened.label, text)
      return { pane: opened.pane, label: opened.label, sessionId: opened.sessionId, ...launchShown(launch), watching: watch, open: `/m/ai/term/${opened.pane}` }
    }
    const label = paneLabel(a.label, t?.label || key)
    const sessionId = randomUUID()
    noteRavenStarted(sessionId, io.now())
    const pane = await newPane({ mode: 'new', host: 'thor', target: key, newId: sessionId, label, cols: 120, rows: 40, ...launch })
    ctx.acted()
    if (watch) await startWatch({ pane, label, sessionId, followUp: a.followUp, fresh: true, title, job: true })
    await promptOrThrow(pane, label)
    noteRavenTouched(sessionId)
    await typeInto(pane, label, text)
    return { pane, label, sessionId, ...launchShown(launch), watching: watch, open: `/m/ai/term/${pane}` }
  }))

  server.registerTool('session_send', {
    description: 'Type a message into a Claude session and press Enter. session is a pane name, a main target key (its main terminal, started if '
      + 'none is open), a conversation id, or a unique part of its label. files are DM attachment ids: each is copied to thor first and its path '
      + 'there goes after the text (thor takes pictures, videos and documents). Everything it writes comes to you unless watch is false; followUp is what you do with '
      + 'the next answer. label names the job on Brendon\'s Watching card: give one whenever the message starts new work, leave it out for a follow-up '
      + 'in the same job. Refused while a question or permission prompt is open in it, or while Brendon has text typed there. '
      + 'model and effort (as in session_start) apply only when this starts the main terminal; refused for a session already running. '
      + 'You may send on your own, in any run (a relay too): pass one session\'s result or hand-off to the session that needs it.',
    inputSchema: {
      session: z.string().max(120), text: z.string().min(1).max(TEXT_MAX), files: z.array(z.string().max(80)).max(8).optional(),
      watch: z.boolean().optional(), followUp: z.string().max(1000).optional(), label: z.string().max(60).optional(),
      model: z.string().max(80).optional(), effort: z.enum(CLAUDE_EFFORTS).optional(),
    },
  }, (a) => toolRun(async () => {
    // no fromBrendon gate: Raven may message any session on its own, relays included;
    // readyToType still refuses an open question or permission prompt, and text Brendon has typed there
    const text = checkText(a.text)
    const launch = launchPick(a.model, a.effort)
    const r = await resolve(a.session, await io.listPanes(), true)
    if (r.kind === 'board') throw new RavenToolError(`${r.title} ${BOARD_ONLY}`)
    if (r.kind === 'pane') notRunning(launch, r.pane.label)
    const paths = a.files?.length ? await attach(a.files) : []
    const line = withFiles(text, paths)
    const watch = a.watch !== false || Boolean(a.followUp)
    // the job's name on the Watching card: Raven's label; a follow-up with none keeps the name it has
    const title = a.label ? oneLine(a.label).slice(0, 60) : undefined
    if (r.kind === 'main') {
      const opened = await openMain(r.target, launch)
      ctx.acted()
      if (watch) await startWatch({ pane: opened.pane, label: opened.label, sessionId: opened.sessionId, followUp: a.followUp, fresh: true, title })
      await promptOrThrow(opened.pane, opened.label)
      noteRavenTouched(opened.sessionId)
      await typeInto(opened.pane, opened.label, line)
      return { pane: opened.pane, label: opened.label, started: true, ...launchShown(launch), attached: paths.length ? paths : undefined, watching: watch, open: `/m/ai/term/${opened.pane}` }
    }
    const p = r.pane
    await readyToType(p)
    if (watch) await startWatch({ pane: p.name, label: p.label, sessionId: p.sessionId, followUp: a.followUp, title })
    noteRavenTouched(p.sessionId)
    await typeInto(p.name, p.label, line)
    ctx.acted()
    return { pane: p.name, label: p.label, attached: paths.length ? paths : undefined, watching: watch, open: `/m/ai/term/${p.name}` }
  }))

  server.registerTool('session_read', {
    description: 'The last few prompts and answers of a session (pane or a window on thor), oldest first, each cut at 2,000 characters.',
    inputSchema: { session: z.string().max(120), last: z.number().int().min(1).max(30).optional() },
  }, (a) => toolRun(async () => {
    const r = await resolve(a.session, await io.listPanes(), true)
    if (r.kind === 'main') return `${r.target.label} has no main terminal open yet.`
    const label = r.kind === 'pane' ? r.pane.label : r.title
    const page = await (r.kind === 'pane' ? io.paneTranscript(r.pane.name, '') : io.boardTranscript(r.sessionId, '')).catch((e: Error) => {
      throw new RavenToolError(`${label}: the transcript could not be read (${e.message.slice(0, 200)})`)
    })
    if (!page?.sessionId) return `${label}: no transcript yet (nothing has been typed into it, or thor's file service is not answering).`
    const entries = page.entries.filter(userOrClaude).slice(-(a.last ?? 6))
    return {
      session: label, pane: r.kind === 'pane' ? r.pane.name : undefined, sessionId: page.sessionId,
      ended: r.kind === 'pane' && r.pane.dead ? true : undefined,
      entries: entries.map((e) => ({ at: et(e.at), from: e.kind === 'user' ? 'prompt' : 'claude', text: clip(e.text!.trim(), 2000) })),
    }
  }))

  server.registerTool('session_watch', {
    description: "Turn watching a session on or off: everything a watched session writes comes to you in full, and you tell Brendon what matters. Turning it on is only when Brendon's message asks; off is always allowed.",
    inputSchema: { session: z.string().max(120), on: z.boolean() },
  }, (a) => toolRun(async () => {
    if (!a.on) {
      const s = a.session.trim().toLowerCase()
      // a blank name is in every label: it would turn off whichever watch there is
      if (!s) throw new RavenToolError('name the session to stop watching: its pane name, label or conversation id')
      const hit = listWatches().filter((w) => w.key.toLowerCase() === s || w.pane.toLowerCase() === s || w.sessionId === s || w.label.toLowerCase().includes(s))
      if (hit.length > 1) throw new RavenToolError(`"${a.session}" matches ${hit.length} watches: ${hit.map((w) => w.label).join(', ')}`)
      if (hit.length === 1) {
        removeWatch(hit[0].key)
        return { watching: false, session: hit[0].label }
      }
      const r = await resolve(a.session, await io.listPanes(), true).catch(() => null)
      const key = r?.kind === 'pane' ? r.pane.name : r?.kind === 'board' ? watchKey('', r.sessionId) : ''
      if (key && removeWatch(key)) return { watching: false, session: a.session }
      return `${a.session} was not being watched.`
    }
    needBrendon(ctx, 'Watching a session')
    const r = await resolve(a.session, await io.listPanes(), true)
    if (r.kind === 'main') throw new RavenToolError(`${r.target.label} has no main terminal open yet`)
    const w = r.kind === 'pane'
      ? await startWatch({ pane: r.pane.name, label: r.pane.label, sessionId: r.pane.sessionId })
      : await startWatch({ pane: '', label: r.title, sessionId: r.sessionId })
    ctx.acted()
    return { watching: true, session: w.label, pane: w.pane || undefined, since: et(w.since) }
  }))

  server.registerTool('session_done', {
    description: "Mark a session done on Brendon's Sessions tab and Desk, the same flag as his done checkbox: it leaves the closed list and Recover all "
      + '(a running one stays under running until it closes). session is a pane name, a conversation id, or part of its label or title, closed ones too. '
      + 'One you started with session_start you may mark on your own; any other only when Brendon\'s message asks.',
    inputSchema: { session: z.string().max(120) },
  }, (a) => toolRun(async () => {
    // without Brendon, a name that matches nothing still gets the gate's answer
    const t = await doneTarget(a.session).catch((e) => { if (ctx.fromBrendon) throw e; return null })
    if (!t || !ravenOwnSession(t.sessionId) || (t.pane && mainOf(t.pane.name))) needBrendon(ctx, 'Marking a session done other than one Raven started')
    if (!t) throw new RavenToolError(`no session matches "${a.session}"`)
    if (!(await io.markDone([t.sessionId]).catch(() => false))) throw new RavenToolError(`thor did not answer, so ${t.label} is not marked done`)
    ctx.acted()
    return { done: true, session: t.label, sessionId: t.sessionId, pane: t.pane?.name }
  }))

  server.registerTool('session_stop', {
    description: 'Stop a session in a pane here: closes the pane, which ends its Claude on thor (the conversation stays resumable). Not for windows on thor. '
      + 'A session you started with session_start you close on your own, in any run (a relay too): in the same run its answer reports the job done, '
      + 'stop it. That ends its background shells and monitors first and marks it done on the Desk. '
      + 'Any other (a main terminal, one Brendon opened) only when Brendon\'s message asks.',
    inputSchema: { session: z.string().max(120) },
  }, (a) => toolRun(async () => {
    // without Brendon, a name that matches nothing still gets the gate's answer, never a hint of what is open
    const r = await resolve(a.session, await io.listPanes(), true).catch((e) => { if (ctx.fromBrendon) throw e; return null })
    const own = r?.kind === 'pane' && ravenLaunched(r.pane)
    if (!own) needBrendon(ctx, 'Stopping a session other than one Raven started')
    if (!r) throw new RavenToolError(`no session matches "${a.session}"`)
    if (r.kind === 'board') throw new RavenToolError(`${r.title} ${BOARD_ONLY}`)
    if (r.kind === 'main') return `${r.target.label} has no main terminal open.`
    const p = r.pane
    if (own) {
      // Raven's own session is finished work: done on the board, so the Desk's closed list and Recover all skip it
      const c = await closeJob(p)
      if (!c.killed) throw new RavenToolError(`${p.label} (${p.name}) could not be stopped; it may have ended already`)
      ctx.acted()
      return { stopped: p.name, label: p.label, markedDone: c.markedDone, ...(c.markedDone ? {} : { note: 'thor did not answer, so it is not marked done on the Desk yet' }) }
    }
    // stopped on purpose: no "ended" line for it; it leaves Watching, whichever way it was watched
    removeWatch(p.name)
    if (p.sessionId) removeWatch(watchKey('', p.sessionId))
    const killed = await io.killPane(p.name)
    // a project run in that pane never reports now, as when the page stops it (routes/terminal.ts)
    if (killed) {
      try { failRunsForTmux(p.name, 'stopped before it reported') } catch (e) { console.error('[raven-tools] runs for', p.name, words(e)) }
    }
    const main = mainOf(p.name)
    if (main) setMain(main, null)
    if (!killed) throw new RavenToolError(`${p.label} (${p.name}) could not be stopped; it may have ended already`)
    ctx.acted()
    // one of Brendon's stays open on the Desk, to resume when he wants it
    return { stopped: p.name, label: p.label }
  }))

  server.registerTool('session_keep', {
    description: 'Keep a session you started with session_start open while it waits on something long (a release, a build, a long test run): '
      + `nothing closes it on its own until minutes from now (default ${KEEP_DEFAULT_MIN}, at most ${KEEP_MAX_MIN}), and its background wait shows `
      + `Working on Brendon's Watching card meanwhile. Without it, a session you started that stays quiet ${AUTO_CLOSE_MIN} minutes after an answer `
      + 'is closed and marked done on its own. Use it in the run whose answer says it still waits; a job that is done gets session_stop instead.',
    inputSchema: { session: z.string().max(120), minutes: z.number().int().min(1).max(KEEP_MAX_MIN).optional() },
  }, (a) => toolRun(async () => {
    const r = await resolve(a.session, await io.listPanes(), false)
    if (r.kind !== 'pane' || !ravenLaunched(r.pane)) throw new RavenToolError('session_keep is only for a session you started with session_start; nothing closes the others on its own')
    const w = getWatch(r.pane.name)
    if (!w?.job) throw new RavenToolError(`${r.pane.label} is not watched as a job, so nothing closes it on its own`)
    const until = io.now() + (a.minutes ?? KEEP_DEFAULT_MIN) * 60_000
    keepWatch(w.key, until)
    return { kept: r.pane.name, label: r.pane.label, until: et(until) }
  }))
}
