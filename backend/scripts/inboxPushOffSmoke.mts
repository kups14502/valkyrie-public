/**
 * Inbox push-off smoke test (lib/inboxStore.ts, 2026-11-01).
 *
 * With VAPID keys set and no subscription, a post that wants a push leaves ONE
 * "Phone notifications are off" item (source valkyrie, tag push-off) that a
 * second failed push does not duplicate or bump; clearPushOff() archives it.
 * resolveInbox() archives an open item by source and tag and leaves others.
 *
 *   VALKYRIE_DATA_DIR=$(mktemp -d) node --import tsx scripts/inboxPushOffSmoke.mts
 */
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import webpush from 'web-push'

const LIVE_DIR = path.join(homedir(), 'valkyrie', 'backend', 'data')
const dataDir = process.env.VALKYRIE_DATA_DIR
if (!dataDir || fs.realpathSync(dataDir) === (() => { try { return fs.realpathSync(LIVE_DIR) } catch { return LIVE_DIR } })()) {
  console.error('inboxPushOffSmoke: set VALKYRIE_DATA_DIR to a scratch directory')
  process.exit(2)
}
const keys = webpush.generateVAPIDKeys()
process.env.VAPID_PUBLIC_KEY = keys.publicKey
process.env.VAPID_PRIVATE_KEY = keys.privateKey

const inbox = await import('../src/lib/inboxStore.ts')

let pass = 0, fail = 0
const check = (name: string, ok: boolean, got?: unknown) => {
  if (ok) pass += 1
  else { fail += 1; console.log('FAIL', name, JSON.stringify(got)?.slice(0, 400)) }
}
const pushOff = () => inbox.listInbox({ source: 'valkyrie' }).filter((i) => i.tag === 'push-off')

const r1 = await inbox.postInbox({ source: 'backups', level: 'warn', title: 'Backup failed' })
check('push found no device', r1.pushed === false && r1.pushDetail === 'no subscriptions', r1)
const first = pushOff()
check('one push-off item', first.length === 1 && first[0].level === 'warn' && first[0].url === '/m/settings', first)

await inbox.postInbox({ source: 'raid', level: 'alert', title: 'Disk failed' })
const second = pushOff()
check('a second failed push adds no twin and does not bump it', second.length === 1 && second[0].count === 1 && second[0].lastAt === first[0].lastAt, second)

await inbox.postInbox({ source: 'capture', level: 'info', title: 'A note', push: false })
check('an item that wants no push leaves it alone', pushOff().length === 1)

inbox.clearPushOff()
check('clearPushOff archives it', pushOff().length === 0 && inbox.listInbox({ view: 'archive', source: 'valkyrie' }).length === 1)

await inbox.postInbox({ source: 'claude', level: 'warn', title: 'Claude sign-in expired', tag: 'claude-signin-a', push: false })
await inbox.postInbox({ source: 'claude', level: 'warn', title: 'Claude sign-in expired', tag: 'claude-signin-b', push: false })
check('resolveInbox archives one tag', inbox.resolveInbox('claude', 'claude-signin-a') === 1)
const left = inbox.listInbox({ source: 'claude' })
check('the other tag stays open', left.length === 1 && left[0].tag === 'claude-signin-b', left)
check('resolving again is a no-op', inbox.resolveInbox('claude', 'claude-signin-a') === 0)

console.log(`inbox push-off smoke: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
