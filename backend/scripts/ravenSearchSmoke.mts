/**
 * Raven search smoke: the find bar's reach past what the Raven tab has loaded. searchMessages (lib/agentsStore.ts)
 * and GET /api/raven/search (routes/raven.ts) over a scratch data dir: case-insensitive hits oldest first with a
 * count per line, other channels left out, an empty or blank query answering nothing, a cap on the query length.
 *
 *   VALKYRIE_DATA_DIR=<scratch> npx tsx scripts/ravenSearchSmoke.mts      (from backend/)
 */
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import type { AddressInfo } from 'node:net'
import express from 'express'

const dataDir = process.env.VALKYRIE_DATA_DIR
const live = path.join(homedir(), 'valkyrie', 'backend', 'data')
if (!dataDir || path.resolve(dataDir) === path.resolve(live) || dataDir.split(path.sep).join('/').includes('valkyrie/backend/data')) {
  console.error('ravenSearchSmoke: set VALKYRIE_DATA_DIR to a scratch directory')
  process.exit(2)
}
fs.mkdirSync(dataDir, { recursive: true })

const { addMessage, searchMessages } = await import('../src/lib/agentsStore.js')
const { RAVEN_CHANNEL } = await import('../src/lib/raven/types.js')
const router = (await import('../src/routes/raven.js')).default

let pass = 0
let fail = 0
const check = (ok: boolean, msg: string) => {
  if (ok) pass++
  else { fail++; console.log(`  FAIL ${msg}`) }
}

const a = addMessage({ channelId: RAVEN_CHANNEL, author: 'brendon', text: 'Is the Plex box up?' })
const b = addMessage({ channelId: RAVEN_CHANNEL, author: 'raven', text: 'plex is up. PLEX answered in 40 ms; plex, plex.' })
addMessage({ channelId: RAVEN_CHANNEL, author: 'raven', text: 'Nothing about that here.' })
addMessage({ channelId: 'other', author: 'east-triage', text: 'plex in another channel' })
const d = addMessage({ channelId: RAVEN_CHANNEL, author: 'raven', text: 'aaaa' })

const hits = searchMessages(RAVEN_CHANNEL, 'plex')
check(hits.length === 2, `two Raven lines hold plex (got ${hits.length})`)
check(hits[0]?.id === a.id && hits[1]?.id === b.id, 'oldest first')
check(hits[0]?.n === 1 && hits[1]?.n === 4, `counts per line 1 and 4 (got ${hits.map((h) => h.n).join(',')})`)
check(searchMessages(RAVEN_CHANNEL, '  PLEX ').length === 2, 'case and outer spaces do not matter')
check(searchMessages(RAVEN_CHANNEL, '').length === 0 && searchMessages(RAVEN_CHANNEL, '   ').length === 0, 'a blank query finds nothing')
check(searchMessages(RAVEN_CHANNEL, 'in another channel').length === 0, 'other channels are left out')
check(searchMessages(RAVEN_CHANNEL, 'aa')[0]?.id === d.id && searchMessages(RAVEN_CHANNEL, 'aa')[0]?.n === 2, 'matches never overlap (aaaa holds aa twice)')
check(searchMessages(RAVEN_CHANNEL, "50% o'clock _x_").length === 0, 'LIKE wildcards and quotes are plain text')

const app = express()
app.use('/api', router)
const server = app.listen(0, '127.0.0.1')
await new Promise((r) => server.once('listening', r))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
try {
  const r = await fetch(`${base}/raven/search?q=Plex`)
  const j = await r.json() as { q: string; hits: { id: number; n: number }[]; total: number }
  check(r.status === 200, `route answers 200 (got ${r.status})`)
  check(j.hits.length === 2 && j.total === 5, `route: 2 lines, 5 matches (got ${j.hits.length}, ${j.total})`)
  const e = await (await fetch(`${base}/raven/search`)).json() as { hits: unknown[]; total: number }
  check(e.hits.length === 0 && e.total === 0, 'route: no q, no hits')
  const long = await (await fetch(`${base}/raven/search?q=${'x'.repeat(500)}`)).json() as { q: string }
  check(long.q.length === 200, `route: the query is cut at 200 chars (got ${long.q.length})`)
  const cf = await fetch(`${base}/raven/search?q=plex`, { headers: { 'cf-connecting-ip': '1.2.3.4', 'cf-ray': 'x' } })
  check(cf.status === 404, `route: through Cloudflare it does not exist (got ${cf.status})`)
} finally {
  server.close()
}

console.log(`ravenSearchSmoke: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
