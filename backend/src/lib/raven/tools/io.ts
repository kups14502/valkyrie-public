import { readFile } from 'node:fs/promises'
import {
  capturePane, capturePaneUndimmed, createSession, endScroll, killSession, listSessions, paneFacts, paneInMode, sendPaneKeys, typeLine, serverUp,
  type CreateOpts, type TermSession,
} from '../../../terminal/tmux.js'
import { pageFrom, paneTranscript, readerFor } from '../../../terminal/transcriptFeed.js'
import type { TranscriptPage } from '../../../terminal/transcript.js'
import { boardNow, boardSessions, launchTargets, markSessionsDone, stopSessionOnHost, uploadToThor, type LaunchTargetInfo } from '../../../routes/hostLaunch.js'
import { resumeOnThor } from '../../../terminal/resume.js'
import { getRavenFile } from '../files.js'
import { findOutside, outsideIo } from './outside.js'
import type { RavenFile } from '../types.js'

// Everything Raven's session tools and the relay watcher touch outside this
// process: tmux panes on odin, thor's launcher agent and file service, the
// transcripts. One object, so the smoke test swaps in fakes and never starts
// a pane, never reaches thor (scripts/ravenToolsSmoke.mts).

export type PaneState = 'live' | 'dead' | 'gone' | 'unknown'
export type BoardRow = Record<string, unknown>

export type RavenToolsIo = {
  listPanes: () => Promise<TermSession[]>
  createPane: (o: CreateOpts) => Promise<string>
  /** a closed conversation reopened in a new pane on thor, as the Desk's Recover does (terminal/resume.ts); the pane's name */
  resumePane: (o: { sessionId: string; label: string; cols: number; rows: number }) => Promise<string>
  capture: (pane: string) => Promise<string | null>
  /** the screen without its dim text (the empty prompt's hint), for the checks before typing */
  capturePrompt: (pane: string) => Promise<string | null>
  typeLine: (pane: string, text: string) => Promise<void>
  /** tmux key names (Enter, Escape, Up) and single letters or digits, one at a time */
  paneKeys: (pane: string, keys: string[]) => Promise<void>
  killPane: (pane: string) => Promise<boolean>
  paneInMode: (pane: string) => Promise<boolean>
  leaveMode: (pane: string) => Promise<void>
  paneState: (pane: string) => Promise<PaneState>
  /** the pane's transcript after a cursor ('' = the newest page); null when there is no such pane */
  paneTranscript: (pane: string, after: string) => Promise<TranscriptPage | null>
  /** a session that has no pane here (a window or an ssh login on thor, a terminal on odin), by its conversation id */
  boardTranscript: (sessionId: string, after: string, host?: 'thor' | 'odin') => Promise<TranscriptPage | null>
  /** the screen of a session that has no pane here (outside.ts); null when it cannot be read */
  outsideScreen: (sessionId: string) => Promise<string | null>
  launchTargets: () => Promise<LaunchTargetInfo[] | null>
  boardSessions: () => Promise<BoardRow[] | null>
  /** thor's board rows as last read (never waits; null when no read in the last minute worked) */
  boardCached: () => BoardRow[] | null
  /** marks conversations done on thor's board (the Desk's closed list); false when thor cannot say */
  markDone: (sessionIds: string[]) => Promise<boolean>
  /** ends a conversation's Claude on thor, its background shells and monitors first; 'none' when nothing runs it there */
  stopOnThor: (sessionId: string) => Promise<'stopped' | 'none' | 'failed'>
  uploadToThor: (name: string, data: Buffer) => Promise<{ path: string }>
  /** a DM attachment and where its bytes are (lib/raven/files.ts) */
  ravenFile: (id: string) => { file: RavenFile; path: string } | null
  readFile: (path: string) => Promise<Buffer>
  sleep: (ms: number) => Promise<void>
  now: () => number
}

async function paneState(pane: string): Promise<PaneState> {
  if (!serverUp()) return 'unknown'
  const facts = await paneFacts(pane)
  if (facts) return facts.dead ? 'dead' : 'live'
  // paneFacts answers null for a tmux hiccup too; only a session tmux says is gone is gone
  const all = await listSessions().catch(() => null)
  if (!all) return 'unknown'
  const row = all.find((s) => s.name === pane)
  return !row ? 'gone' : row.dead ? 'dead' : 'live'
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const real: RavenToolsIo = {
  listPanes: listSessions,
  createPane: createSession,
  resumePane: (o) => resumeOnThor({ ...o, ctx: { actor: 'raven', via: 'mcp' } }),
  capture: capturePane,
  capturePrompt: capturePaneUndimmed,
  typeLine,
  paneKeys: sendPaneKeys,
  killPane: killSession,
  paneInMode,
  leaveMode: endScroll,
  paneState,
  paneTranscript,
  boardTranscript: async (sessionId, after, host = 'thor') => {
    if (!UUID.test(sessionId)) return null
    // thor's file service reads it by id, as it does for a pane's conversation; on odin the file is read here
    const facts = { host, mode: 'resume', sessionId, panePid: 0, dead: false }
    return pageFrom(readerFor(`sid-${sessionId}`, facts), after, `raven-${host === 'odin' ? 'odin' : 'board'}:${sessionId}`)
  },
  outsideScreen: async (sessionId) => {
    const o = await findOutside(sessionId).catch(() => null)
    if (!o || o.via === 'none') return null
    return outsideIo.screen(o).catch(() => null)
  },
  launchTargets: () => launchTargets('thor', 8_000),
  boardSessions: () => boardSessions(20_000),
  boardCached: () => boardNow()?.rows ?? null,
  markDone: (ids) => markSessionsDone(ids),
  stopOnThor: (id) => stopSessionOnHost(id),
  uploadToThor,
  ravenFile: (id) => getRavenFile(id),
  readFile: (p) => readFile(p),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
}

export const io: RavenToolsIo = { ...real }

const resets: (() => void)[] = []

/** Something that caches what io returned registers here, so a swap starts clean. */
export function onIoReset(fn: () => void): void {
  resets.push(fn)
}

/** Swap parts of the io (the smoke test); null puts the real ones back. */
export function setRavenToolsIo(patch: Partial<RavenToolsIo> | null): void {
  Object.assign(io, real, patch ?? {})
  for (const fn of resets) fn()
}
