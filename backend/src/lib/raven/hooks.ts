import type { Ref } from '../agentsStore.js'
import type { RavenMeta, RavenNotice } from './types.js'

// The doors into Raven for code that runs inside the API but is not Raven's
// run loop: a feature, the session watcher (lib/raven/tools), Valkyrie's own
// alerts. The run loop installs the handlers at start (lib/raven/run.ts
// startRaven); until then, and when Raven is off, calls are dropped. Code that
// runs OUTSIDE the API (a feature's own process, odin scripts) posts a RavenNotice
// to POST /api/raven/notify on 127.0.0.1 instead.

type NoticeHandler = (n: RavenNotice) => void
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

/** Hand a notice to Raven's DM. Never throws. */
export function notifyRaven(n: RavenNotice): void {
  safe('notice', () => noticeHandler?.(n))
}

/** A message in the DM authored by Raven (a relay, a watcher line). push sends it to the phone. Never throws. */
export function ravenPost(text: string, opts?: { refs?: Ref[]; meta?: RavenMeta; push?: boolean }): void {
  safe('post', () => poster?.(text, opts))
}

/** Queue an event for Raven and wake it (a watched session answered and a follow-up was asked for). Never throws. */
export function wakeRavenWith(kind: string, payload: Record<string, unknown>): void {
  safe('wake', () => waker?.(kind, payload))
}
