import type { Ref } from '../agentsStore.js'
import type { RavenMeta, RavenNotice } from './types.js'

// The doors into Raven for code that runs inside the API but is not Raven's
// run loop: a feature, the session watcher (lib/raven/tools), Valkyrie's own
// alerts. The run loop installs the handlers at start (lib/raven/run.ts
// startRaven); until then, and when Raven is off, calls are dropped. Code that
// runs OUTSIDE the API (a feature's own process, odin scripts) posts a RavenNotice
// to POST /api/raven/notify on 127.0.0.1 instead.

/** direct: straight into the thread, never handed to an agent (an agent's own fallback) */
export type NoticeOpts = { direct?: boolean }
type NoticeHandler = (n: RavenNotice, opts: NoticeOpts) => void
type Poster = (text: string, opts?: { refs?: Ref[]; meta?: RavenMeta; push?: boolean }) => void
type Waker = (kind: string, payload: Record<string, unknown>) => void

let noticeHandler: NoticeHandler | null = null
let poster: Poster | null = null
let waker: Waker | null = null

export function setRavenNoticeHandler(h: NoticeHandler | null): void { noticeHandler = h }
export function setRavenPoster(p: Poster | null): void { poster = p }
export function setRavenWaker(w: Waker | null): void { waker = w }

function safe(what: string, fn: () => void): void {
  try {
    fn()
  } catch (e) {
    console.error(`[raven] ${what}:`, (e as Error).message)
  }
}

/** Hand a notice to Raven's DM (or to the feature agent that takes it). Never throws. */
export function notifyRaven(n: RavenNotice, opts: NoticeOpts = {}): void {
  safe('notice', () => noticeHandler?.(n, opts))
}

/** A message in the DM authored by Raven (a relay, a watcher line). push sends it to the phone. Never throws. */
export function ravenPost(text: string, opts?: { refs?: Ref[]; meta?: RavenMeta; push?: boolean }): void {
  safe('post', () => poster?.(text, opts))
}

/** Queue an event for Raven and wake it (what a watched session wrote, an agent's answer). Never throws. False when Raven did not take it. */
export function wakeRavenWith(kind: string, payload: Record<string, unknown>): boolean {
  if (!waker) return false
  let took = false
  safe('wake', () => { waker!(kind, payload); took = true })
  return took
}
