import { pushToAll } from '../../routes/push.js'

// Every push out of Raven's DM: Raven's replies, relays, mirrored agent posts
// and notices. One tag and one landing screen, so the phone folds them into
// one notification. At most one buzz per 20 s, except a reply to a message
// Brendon just sent (he is waiting on that one).

const THROTTLE_MS = Number(process.env.RAVEN_PUSH_THROTTLE_MS || 20_000)
let last = 0

/** The first plain line of a message, for a notification body. */
export function pushLine(text: string): string {
  return text.split('\n').map((l) => l.replace(/[*_`#>]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim()).find(Boolean)?.slice(0, 160) ?? ''
}

/** Sends one push unless one went out in the last 20 s. Returns whether it went. Never throws. */
export function ravenPush(title: string, text: string, opts: { force?: boolean } = {}): boolean {
  const now = Date.now()
  if (!opts.force && now - last < THROTTLE_MS) return false
  last = now
  const body = pushLine(text) || 'New message'
  void pushToAll({ title, body, tag: 'raven', url: '/m/raven' }).catch(() => {})
  return true
}
