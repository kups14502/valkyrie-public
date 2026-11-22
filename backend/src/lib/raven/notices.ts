import { AgentError, currentSeq, newestRelays, nowIso, relayMessages, updateMessage, type Message } from '../agentsStore.js'
import { RAVEN_CHANNEL, type RavenMeta, type RavenNoticeClear } from './types.js'

// Live notices: a feed's line about a state that changes ("9 items waiting for
// your review", an open incident). The notice carries a key (RavenNotice.live);
// when the state moves, its source says so (clearNotice, over POST
// /api/raven/notify/clear) and the line keeps up: the count as it stands shows
// beside it (relay.now), and an empty queue or a cleared incident marks it
// cleared (relay.cleared). A newer notice with the same key clears the older
// one. The Raven tab's Connected list shows each feed's newest line and leaves
// a cleared one out, so a count that is no longer true never sits there.

export const SOURCE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
export const LIVE_RE = /^[a-z0-9][a-z0-9._:-]{0,119}$/i
/** the relay kinds a notice posts as (lib/raven/run.ts postNotice) */
const NOTICE_KINDS = ['feature', 'system']
/** how far back a source's notices are looked through for open ones */
const SCAN = 300

type Relay = NonNullable<RavenMeta['relay']>

const firstLine = (text: string) => text.split('\n')[0].trim()
const oneLine = (s: string, max: number) => s.replace(/\s+/g, ' ').trim().slice(0, max)

/** The open (not cleared) notices of one source and key, newest first; legacy also takes a keyless one whose first line ends with it. */
function openLive(source: string, live: string, legacy?: string): Message[] {
  return relayMessages(RAVEN_CHANNEL, source, NOTICE_KINDS, SCAN).filter((m) => {
    const r = m.meta.relay
    if (!r || r.cleared) return false
    if (r.live) return r.live === live
    return !!legacy && firstLine(m.text).endsWith(legacy)
  })
}

function setRelay(m: Message, patch: Partial<Relay>): void {
  updateMessage(m.id, { meta: { ...m.meta, relay: { ...m.meta.relay!, ...patch } } })
}

/** A key a notice may carry, or '' for none; a malformed one is refused. */
export function liveKey(v: unknown): string {
  if (v === undefined || v === null || v === '') return ''
  const live = typeof v === 'string' ? v.trim() : ''
  if (!LIVE_RE.test(live)) throw new AgentError(400, 'live must be a short key like review')
  return live
}

/** A newer notice with the same key went up (keepId): every older open one is cleared as replaced. Answers how many. */
export function replaceLive(source: string, live: string, keepId: number): number {
  let n = 0
  for (const m of openLive(source, live)) {
    if (m.id === keepId) continue
    setRelay(m, { cleared: { at: nowIso(), note: 'a newer notice replaced it' } })
    n++
  }
  return n
}

/**
 * The state a live notice reported moved (c.now, one line) or is over (no now): its open notices say so. A now equal
 * to a notice's own first line takes the earlier now away. Answers how many lines changed; 0 writes nothing.
 */
export function clearNotice(c: RavenNoticeClear): number {
  const source = String(c?.source ?? '').trim().toLowerCase()
  if (!SOURCE_RE.test(source)) throw new AgentError(400, 'source must be a short key like backup')
  const live = liveKey(c.live)
  if (!live) throw new AgentError(400, 'live must be a short key like review')
  const now = typeof c.now === 'string' ? oneLine(c.now, 300) : ''
  const note = typeof c.note === 'string' ? oneLine(c.note, 80) : ''
  const legacy = typeof c.legacy === 'string' && c.legacy.trim() ? c.legacy.trim().slice(0, 120) : undefined
  let changed = 0
  for (const m of openLive(source, live, legacy)) {
    if (now) {
      const want = now === firstLine(m.text) ? undefined : now
      if (m.meta.relay!.now === want && m.meta.relay!.live === live) continue
      setRelay(m, { live, now: want })
    } else {
      setRelay(m, { live, cleared: note ? { at: nowIso(), note } : { at: nowIso() } })
    }
    changed++
  }
  return changed
}

/** One feed in the Raven tab's Connected list: its source, name and newest line (the count as it stands, when it moved). */
export type RavenFeed = { from: string; label: string; text: string; at: string; id: number }

let feedCache: { seq: number; feeds: RavenFeed[] } | null = null

/** Each feed's newest line, newest first. A feed whose newest line is cleared is left out; an older line never shows in its place. */
export function ravenFeeds(): RavenFeed[] {
  const seq = currentSeq()
  if (feedCache?.seq === seq) return feedCache.feeds
  const feeds = newestRelays(RAVEN_CHANNEL, ['feature']).flatMap((m): RavenFeed[] => {
    const r = m.meta.relay
    if (!r || r.cleared) return []
    const text = r.now || firstLine(m.text).replace(/[*_`#>]/g, '').trim()
    return [{ from: r.from, label: r.label || r.from, text, at: m.createdAt, id: m.id }]
  })
  feedCache = { seq, feeds }
  return feeds
}

/** A live notice's state as Raven reads the thread: " [cleared <at>: <note>]" or " [now: <count>]", else ''. */
export function liveTag(m: Message, at: (iso: string) => string): string {
  const r = m.meta.relay
  if (r?.cleared) return ` [cleared ${at(r.cleared.at)}${r.cleared.note ? `: ${r.cleared.note}` : ''}]`
  if (r?.now) return ` [now: ${r.now}]`
  return ''
}
