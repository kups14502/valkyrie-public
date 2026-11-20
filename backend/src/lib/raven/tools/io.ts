import { readFile } from 'node:fs/promises'
import {
  capturePane, capturePaneUndimmed, createSession, endScroll, killSession, listSessions, paneFacts, paneInMode, typeLine, serverUp,
  type CreateOpts, type TermSession,
} from '../../../terminal/tmux.js'
import { pageFrom, paneTranscript, readerFor } from '../../../terminal/transcriptFeed.js'
import type { TranscriptPage } from '../../../terminal/transcript.js'
import { boardSessions, launchTargets, uploadToThor, type LaunchTargetInfo } from '../../../routes/hostLaunch.js'
import { getRavenFile } from '../files.js'
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
  capture: (pane: string) => Promise<string | null>
  /** the screen without its dim text (the empty prompt's hint), for the checks before typing */
  capturePrompt: (pane: string) => Promise<string | null>
  typeLine: (pane: string, text: string) => Promise<void>
  killPane: (pane: string) => Promise<boolean>
  paneInMode: (pane: string) => Promise<boolean>
  leaveMode: (pane: string) => Promise<void>
  paneState: (pane: string) => Promise<PaneState>
  /** the pane's transcript after a cursor ('' = the newest page); null when there is no such pane */
  paneTranscript: (pane: string, after: string) => Promise<TranscriptPage | null>
  /** a thor session that has no pane here (a Windows Terminal window on thor), by its conversation id */
  boardTranscript: (sessionId: string, after: string) => Promise<TranscriptPage | null>
  launchTargets: () => Promise<LaunchTargetInfo[] | null>
  boardSessions: () => Promise<BoardRow[] | null>
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
  capture: capturePane,
  capturePrompt: capturePaneUndimmed,
  typeLine,
  killPane: killSession,
  paneInMode,
  leaveMode: endScroll,
  paneState,
  paneTranscript,
  boardTranscript: async (sessionId, after) => {
    if (!UUID.test(sessionId)) return null
    // thor's file service reads it by id, as it does for a pane's conversation
    const facts = { host: 'thor' as const, mode: 'resume', sessionId, panePid: 0, dead: false }
    return pageFrom(readerFor(`sid-${sessionId}`, facts), after, `raven-board:${sessionId}`)
  },
  launchTargets: () => launchTargets('thor', 8_000),
  boardSessions: () => boardSessions(20_000),
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
