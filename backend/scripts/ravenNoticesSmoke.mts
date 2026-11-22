/**
 * Raven live notices smoke: a feed's notice about a state that changes (lib/raven/notices.ts). postNotice with a
 * live key, a newer notice clearing the older one, clearNotice moving the count (relay.now) or clearing it, a
 * legacy notice without a key, other sources and keys left alone, the feeds list the Raven tab shows (a cleared
 * newest line leaves its feed out, an older line never takes its place), Raven's view of a cleared line, and
 * POST /api/raven/notify/clear (loopback only) over a scratch data dir.
 *
 *   VALKYRIE_DATA_DIR=<scratch> npx tsx scripts/ravenNoticesSmoke.mts      (from backend/)
 */
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import type { AddressInfo } from 'node:net'
import express from 'express'

const dataDir = process.env.VALKYRIE_DATA_DIR
const live = path.join(homedir(), 'valkyrie', 'backend', 'data')
if (!dataDir || path.resolve(dataDir) === path.resolve(live) || dataDir.split(path.sep).join('/').includes('valkyrie/backend/data')) {
  console.error('ravenNoticesSmoke: set VALKYRIE_DATA_DIR to a scratch directory')
  process.exit(2)
}
fs.mkdirSync(dataDir, { recursive: true })

const { currentSeq, getMessage, newestRelays, relayMessages } = await import('../src/lib/agentsStore.js')
const { postNotice } = await import('../src/lib/raven/run.js')
const { clearNotice, liveTag, ravenFeeds } = await import('../src/lib/raven/notices.js')
const { readThread } = await import('../src/lib/raven/history.js')
const { RAVEN_CHANNEL } = await import('../src/lib/raven/types.js')
const router = (await import('../src/routes/raven.js')).default

let pass = 0
let fail = 0
const check = (ok: boolean, msg: string, got?: unknown) => {
  if (ok) pass++
  else { fail++; console.log(`  FAIL ${msg}${got === undefined ? '' : `\n    got: ${JSON.stringify(got)?.slice(0, 400)}`}`) }
}
const throws = (fn: () => unknown): string => { try { fn(); return '' } catch (e) { return `${(e as { status?: number }).status ?? ''} ${(e as Error).message}` } }
const relay = (id: number) => getMessage(id)!.meta.relay!
const dogFeed = () => ravenFeeds().find((f) => f.from === 'watchdog')
const NY = (iso: string) => `at ${iso.slice(11, 16)}`

// ------------------------------------------------------------ a live notice ---

const legacy = postNotice({ source: 'watchdog', label: 'Watchdog', level: 'info', title: '1 item waiting for your review', body: 'Line one 1.', tag: 'review-3' })
const incident = postNotice({ source: 'watchdog', label: 'Watchdog', level: 'info', title: 'Line two: 7 rounds left', tag: 'dog-l2-rounds' })
const backup = postNotice({ source: 'backup', label: 'Backup', level: 'info', title: 'Backup is done', tag: 'run-1' })
const r1 = postNotice({ source: 'watchdog', label: 'Watchdog', level: 'info', title: '9 items waiting for your review', body: 'Shop 9. Review has every line in one queue.', tag: 'review-12', live: 'review' })
check('a live notice posts', r1.posted && !!r1.message, r1)
const id1 = r1.message!.id
check('it carries its key in the relay', relay(id1).live === 'review' && relay(id1).kind === 'feature' && relay(id1).from === 'watchdog', relay(id1))
check('a notice with no key carries none', getMessage(legacy.message!.id)!.meta.relay!.live === undefined)
check('relayMessages: one source, newest first', relayMessages(RAVEN_CHANNEL, 'watchdog', ['feature']).map((m) => m.id).join() === [id1, incident.message!.id, legacy.message!.id].join())
check('newestRelays: the newest line of each source', newestRelays(RAVEN_CHANNEL, ['feature']).map((m) => m.id).join() === [id1, backup.message!.id].join())

let feeds = ravenFeeds()
check('feeds: newest first, one line each', feeds.map((f) => `${f.from}:${f.text}`).join('|') === 'watchdog:9 items waiting for your review|backup:Backup is done', feeds)
check('feeds: the source name and the message id', dogFeed()?.label === 'Watchdog' && dogFeed()?.id === id1, dogFeed())

// --------------------------------------------------------- the count moves ---

check('a moved count: one line changes', clearNotice({ source: 'watchdog', live: 'review', now: '4 items waiting for your review' }) === 1)
check('the line keeps its text, the count as it stands beside it', relay(id1).now === '4 items waiting for your review' && getMessage(id1)!.text.startsWith('9 items'), relay(id1))
check('feeds show the count as it stands', dogFeed()?.text === '4 items waiting for your review', dogFeed())
let seq = currentSeq()
check('the same count again changes nothing', clearNotice({ source: 'watchdog', live: 'review', now: '4 items  waiting for your review ' }) === 0 && currentSeq() === seq)
check('back to the count it said: the now goes away', clearNotice({ source: 'watchdog', live: 'review', now: '9 items waiting for your review' }) === 1 && relay(id1).now === undefined, relay(id1))
check('a key nobody posted changes nothing', clearNotice({ source: 'watchdog', live: 'other' }) === 0 && !relay(id1).cleared)
check('another source with the same key changes nothing', clearNotice({ source: 'backup', live: 'review' }) === 0 && !relay(id1).cleared)

// ---------------------------------------------------- a newer notice takes over ---

const r2 = postNotice({ source: 'watchdog', label: 'Watchdog', level: 'info', title: '12 items waiting for your review', tag: 'review-15', live: 'review' })
const id2 = r2.message!.id
check('a newer notice with the key clears the older one', relay(id1).cleared?.note === 'a newer notice replaced it' && !relay(id2).cleared, [relay(id1), relay(id2)])
check('feeds show the newer one', dogFeed()?.id === id2 && dogFeed()?.text === '12 items waiting for your review', dogFeed())
check('a keyless notice is not replaced', !relay(legacy.message!.id).cleared && !relay(incident.message!.id).cleared)

// ------------------------------------------------------------ the queue empties ---

check('an empty queue clears the open notice', clearNotice({ source: 'watchdog', live: 'review', note: 'All reviewed' }) === 1)
const c2 = relay(id2).cleared
check('cleared: when, and the word', !!c2 && Number.isFinite(Date.parse(c2.at)) && c2.note === 'All reviewed', c2)
check('the cleared newest line leaves its feed out; no older Watchdog line shows in its place', dogFeed() === undefined, ravenFeeds())
check('other feeds stay', ravenFeeds().some((f) => f.from === 'backup'), ravenFeeds())
seq = currentSeq()
check('clearing again changes nothing', clearNotice({ source: 'watchdog', live: 'review' }) === 0 && currentSeq() === seq)
check('a count on a cleared notice changes nothing', clearNotice({ source: 'watchdog', live: 'review', now: '2 items waiting for your review' }) === 0 && relay(id2).now === undefined)

// ------------------------------------------------------- a notice from before keys ---

check('legacy off: a keyless notice stays open', !relay(legacy.message!.id).cleared)
check('legacy: a keyless notice whose first line ends with it is cleared and takes the key',
  clearNotice({ source: 'watchdog', live: 'review', note: 'All reviewed', legacy: 'waiting for your review' }) === 1
  && relay(legacy.message!.id).cleared?.note === 'All reviewed' && relay(legacy.message!.id).live === 'review', relay(legacy.message!.id))
check('legacy: a keyless notice with other words stays open', !relay(incident.message!.id).cleared, relay(incident.message!.id))
check('legacy count: the keyless incident gets the count and the key',
  clearNotice({ source: 'watchdog', live: 'dog-l2-rounds', now: 'Line two: 4 rounds left', legacy: 'Line two: 7 rounds left' }) === 1
  && relay(incident.message!.id).now === 'Line two: 4 rounds left' && relay(incident.message!.id).live === 'dog-l2-rounds', relay(incident.message!.id))
check('then it clears by its key alone', clearNotice({ source: 'watchdog', live: 'dog-l2-rounds', note: 'Cleared' }) === 1 && relay(incident.message!.id).cleared?.note === 'Cleared')

// --------------------------------------------------------------- Raven reads it ---

check('liveTag: a cleared line', liveTag(getMessage(id2)!, NY) === ` [cleared ${NY(c2!.at)}: All reviewed]`, liveTag(getMessage(id2)!, NY))
const r3 = postNotice({ source: 'watchdog', label: 'Watchdog', level: 'info', title: '3 items waiting for your review', live: 'review' })
clearNotice({ source: 'watchdog', live: 'review', now: '1 item waiting for your review' })
check('liveTag: a moved count', liveTag(getMessage(r3.message!.id)!, NY) === ' [now: 1 item waiting for your review]', liveTag(getMessage(r3.message!.id)!, NY))
check('liveTag: a plain line says nothing', liveTag(getMessage(backup.message!.id)!, NY) === '')
const read = readThread({ id: id2 })
check('thread_read marks a cleared notice', /cleared .*: All reviewed/.test(read.split('\n')[0]), read.slice(0, 300))

// ------------------------------------------------------------------ refused ---

check('clear: a bad source is refused 400', throws(() => clearNotice({ source: 'Bad Source!', live: 'review' })).startsWith('400'))
check('clear: no key is refused 400', throws(() => clearNotice({ source: 'watchdog', live: '' })).startsWith('400'))
check('clear: a malformed key is refused 400', throws(() => clearNotice({ source: 'watchdog', live: 'two words' })).startsWith('400'))
check('notice: a malformed key is refused 400', throws(() => postNotice({ source: 'watchdog', level: 'info', title: 'x', live: 'two words' })).startsWith('400'))

// --------------------------------------------------------------- the routes ---

const app = express()
app.use(express.json())
app.use('/api', router)
const server = app.listen(0, '127.0.0.1')
await new Promise((r) => server.once('listening', r))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
const post = async (p: string, body: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  return [r.status, await r.json().catch(() => null)] as [number, any]
}
try {
  let [st, j] = await post('/raven/notify', { source: 'shelf', label: 'Shelf', level: 'info', title: '5 boxes waiting', live: 'boxes', tag: 'boxes-5' })
  check('route: a live notice posts', st === 200 && j?.posted === true, [st, j])
  const box = relayMessages(RAVEN_CHANNEL, 'shelf', ['feature'])[0]
  check('route: it carries its key', box?.meta.relay?.live === 'boxes', box?.meta)
  ;[st, j] = await post('/raven/notify/clear', { source: 'shelf', live: 'boxes', now: '2 boxes waiting' })
  check('route: clear with now answers changed 1', st === 200 && j?.changed === 1, [st, j])
  check('route: feeds show it', ravenFeeds().find((f) => f.from === 'shelf')?.text === '2 boxes waiting', ravenFeeds())
  ;[st, j] = await post('/raven/notify/clear', { source: 'shelf', live: 'boxes', note: 'All packed' })
  check('route: clear answers changed 1, and the feed is gone', st === 200 && j?.changed === 1 && !ravenFeeds().some((f) => f.from === 'shelf'), [st, j])
  ;[st] = await post('/raven/notify/clear', { source: 'shelf', live: 'boxes' }, { origin: 'http://127.0.0.1' })
  check('route: from a browser 403', st === 403, st)
  ;[st] = await post('/raven/notify/clear', { source: 'shelf', live: 'two words' })
  check('route: a malformed key 400', st === 400, st)
  ;[st] = await post('/raven/notify', { source: 'shelf', level: 'info', title: 'x', live: 'two words' })
  check('route: a notice with a malformed key 400', st === 400, st)
} finally {
  server.close()
}

console.log(`ravenNoticesSmoke: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
