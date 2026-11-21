import { paneLimitState } from '../../accountSwitchCore.js'
import { screenBusy } from '../../../terminal/paneState.js'
import { ravenPost } from '../hooks.js'
import { io } from './io.js'
import { closeJob, isRavenJob } from './sessions.js'
import { AUTO_CLOSE_MS, closesAt, getWatch, listWatches } from './watch.js'
import { etClock } from './util.js'

// The safety net under Raven closing its own jobs. Every answer of a job (a
// session Raven opened with session_start) wakes Raven, and the run that reads
// "the job is done" stops it (watch.ts). When that run does not, the job
// closes here: AUTO_CLOSE_MS after its newest answer was relayed with nothing
// new since, unless Raven holds it with session_keep while it waits on a
// release or a build. Closing ends its background shells and monitors on thor
// first, then the pane, and marks it done on the Desk (sessions.ts closeJob).
//
// Only a job is ever closed here: never a main terminal, a pane Brendon
// opened, or a window on thor. Nor a job he is in: a client attached, or a key
// or an attach in the last AUTO_CLOSE_MS (tmux's session activity moves only on
// those). Nor one mid-turn (the spinner), one at a question or permission
// prompt, or one with text typed in its prompt. Those are looked at again on
// the next pass.

/** One pass, after the watcher's: closes every job that is due. Answers the panes it closed. */
export async function closeQuietJobs(): Promise<string[]> {
  const now = io.now()
  const due = listWatches().filter((w) => {
    const at = closesAt(w)
    return at !== null && at <= now
  })
  if (!due.length) return []
  const panes = await io.listPanes()
  const closed: string[] = []
  for (const w of due) {
    const p = panes.find((x) => x.name === w.pane)
    // a pane that ended meanwhile: the watcher's own pass posts its "ended" line
    if (!p || !isRavenJob(p)) continue
    if (p.clients > 0 || now - p.activityAt < AUTO_CLOSE_MS) continue
    const screen = await io.capturePrompt(p.name).catch(() => null)
    if (screen == null || screenBusy(screen)) continue
    const v = paneLimitState(screen)
    if (!v.promptFound || !v.promptEmpty) continue
    // a tool can change it while the screen is read: Raven typed into it, kept it, or stopped it
    const cur = getWatch(w.key)
    const at = cur ? closesAt(cur) : null
    if (!cur || cur.since !== w.since || at === null || at > io.now()) continue
    const r = await closeJob(p)
    if (!r.killed) continue
    closed.push(p.name)
    const when = cur.relayedAt ? ` (${etClock(cur.relayedAt)})` : ''
    const text = `${cur.title || cur.label} closed${r.markedDone ? ' and marked done' : ''}: quiet for ${AUTO_CLOSE_MS / 60_000} minutes after its last answer${when}.`
      + (r.markedDone ? '' : ' It is not marked done on the Desk yet: thor did not answer.')
    ravenPost(text, { meta: { relay: { kind: 'session', from: p.name, label: cur.label, sessionId: cur.sessionId || undefined } } })
    console.log(`[raven-autoclose] closed ${p.name} (${cur.label}), marked done: ${r.markedDone}`)
  }
  return closed
}
