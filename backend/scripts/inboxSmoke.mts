/**
 * Inbox smoke test.
 *
 * Mounts routes/inbox.ts on a throwaway express app and drives it over HTTP:
 * validation, a title taken from the body's first line, Discord markdown
 * stripped, folding by tag, the push decision (levels, the sender's flag, the
 * source's on/off setting), the Discord fallback for an alert that reached no
 * device (a stub Lil' kups records its arguments), the open and archive views,
 * read and unread, archive and back, and the count. Push has no VAPID keys
 * here, so every push "reaches no device", which is exactly the fallback case.
 *
 * Run on odin from a scratch copy (better-sqlite3 has no Windows build here):
 *   VALKYRIE_DATA_DIR=$(mktemp -d) npx tsx scripts/inboxSmoke.mts
 */
import express from 'express'
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const scratch = mkdtempSync(path.join(tmpdir(), 'inbox-smoke-'))
const stubLog = path.join(scratch, 'lilkups.args')
const stub = path.join(scratch, 'lilkups')
writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${stubLog}'\n`)
chmodSync(stub, 0o755)
process.env.LILKUPS_BIN = stub
delete process.env.VAPID_PUBLIC_KEY
delete process.env.VAPID_PRIVATE_KEY

const { default: route } = await import('../src/routes/inbox.ts')
const app = express(); app.use(express.json()); app.use('/api', route)
const srv = app.listen(0); const port = (srv.address() as any).port
const base = `http://127.0.0.1:${port}/api`
const j = async (m: string, p: string, b?: any) => {
  const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })
  return [r.status, await r.json()] as const
}

let pass = 0, fail = 0
const check = (name: string, ok: boolean, got?: unknown) => {
  if (ok) pass += 1
  else { fail += 1; console.log('FAIL', name, JSON.stringify(got)) }
}

// validation
check('no source', (await j('POST', '/inbox', { body: 'x' }))[0] === 400)
check('bad source', (await j('POST', '/inbox', { source: 'Bad Source', body: 'x' }))[0] === 400)
check('no text', (await j('POST', '/inbox', { source: 'test' }))[0] === 400)
check('bad level', (await j('POST', '/inbox', { source: 'test', body: 'x', level: 'loud' }))[0] === 400)
check('bad url', (await j('POST', '/inbox', { source: 'test', body: 'x', url: 'javascript:alert(1)' }))[0] === 400)
check('protocol-relative url', (await j('POST', '/inbox', { source: 'test', body: 'x', url: '//evil.example' }))[0] === 400)

// title from the first line, markdown stripped, info does not push
const [s1, r1] = await j('POST', '/inbox', { source: 'trade', message: '**Guard v2** | 10:20 ET\ntrimmed **XYZ** 10%' })
check('info post', s1 === 200 && r1.ok && r1.pushed === false && r1.pushDetail === null, r1)
const list1 = (await j('GET', '/inbox'))[1]
const it1 = list1.items.find((i: any) => i.id === r1.id)
check('title from first line', it1?.title === 'Guard v2 | 10:20 ET', it1)
check('body is the rest', it1?.body === 'trimmed XYZ 10%', it1)
check('count unread 1', list1.count.unread === 1, list1.count)

// warn pushes (and fails: no VAPID), no Discord fallback for warn
const [, r2] = await j('POST', '/inbox', { source: 'backups', level: 'warn', title: 'Backup watchdog: 1 problem', body: '- Obsidian backup: 30h ago' })
check('warn tried push', r2.pushed === false && /VAPID/.test(r2.pushDetail ?? ''), r2)
check('no fallback for warn', !existsSync(stubLog))

// alert that reached no device falls back to Discord, with --discord so it cannot loop
const [, r3] = await j('POST', '/inbox', { source: 'raid', level: 'alert', title: '[odin RAID] Fail on /dev/md0', body: 'mdstat: ...' })
check('alert tried push', r3.pushed === false, r3)
// the fallback runs after the reply (the sender never waits on Discord)
for (let i = 0; i < 30 && !existsSync(stubLog); i++) await new Promise((r) => setTimeout(r, 100))
const args = existsSync(stubLog) ? readFileSync(stubLog, 'utf8') : ''
check('alert fell back to Discord', args.includes('send --discord --message=[odin RAID] Fail on /dev/md0'), args)

// the sender's push flag: info with push:true pushes, warn with push:false does not
const [, r4] = await j('POST', '/inbox', { source: 'ranking', body: 'Published', push: true })
check('push:true on info', r4.pushDetail !== null, r4)
const [, r5] = await j('POST', '/inbox', { source: 'ranking', level: 'warn', body: 'Upload failed', push: false })
check('push:false on warn', r5.pushDetail === null, r5)

// the source setting wins over the sender: off silences an alert, on pushes info
check('bad setting', (await j('PUT', '/inbox/sources/raid', { push: 'loud' }))[0] === 400)
check('set off', (await j('PUT', '/inbox/sources/raid', { push: 'off' }))[0] === 200)
const [, r6] = await j('POST', '/inbox', { source: 'raid', level: 'alert', body: 'second' })
check('off silences alert', r6.pushDetail === null, r6)
await j('PUT', '/inbox/sources/trade', { push: 'on' })
const [, r7] = await j('POST', '/inbox', { source: 'trade', body: 'report', push: false })
check('on pushes info over push:false', r7.pushDetail !== null, r7)

// folding by tag: same source + tag updates in place, unread again, count 2
const [, f1] = await j('POST', '/inbox', { source: 'odin', level: 'alert', title: 'Disk at 94%', tag: 'disk', push: false })
await j('POST', '/inbox/read', { ids: [f1.id] })
const [, f2] = await j('POST', '/inbox', { source: 'odin', level: 'info', title: 'Disk back under 90%', tag: 'disk', push: false })
check('folded', f2.folded === true && f2.id === f1.id, f2)
const folded = (await j('GET', '/inbox?source=odin'))[1].items
check('one row', folded.length === 1 && folded[0].count === 2 && folded[0].title === 'Disk back under 90%' && folded[0].readAt === null && folded[0].level === 'info', folded)
// a tag on another source is a different item
const [, f3] = await j('POST', '/inbox', { source: 'vaultwarden', title: 'x', tag: 'disk', push: false })
check('tag is per source', f3.folded === false)

// read / unread
const all = (await j('GET', '/inbox'))[1]
const unreadBefore = all.count.unread
check('read one', (await j('POST', '/inbox/read', { ids: [r1.id] }))[1].changed === 1)
check('read again is no change', (await j('POST', '/inbox/read', { ids: [r1.id] }))[1].changed === 0)
check('unread count dropped', (await j('GET', '/inbox/count'))[1].unread === unreadBefore - 1)
check('mark unread', (await j('POST', '/inbox/read', { ids: [r1.id], read: false }))[1].changed === 1)
check('empty selection refused', (await j('POST', '/inbox/read', {}))[0] === 400)
const [, rs] = await j('POST', '/inbox/read', { source: 'ranking' })
check('read by source', rs.changed === 2, rs)
check('alerts count', (await j('GET', '/inbox/count'))[1].alerts >= 1)

// archive: read-only archive leaves unread ones, then back
const [, ar] = await j('POST', '/inbox/archive', { all: true, readOnly: true })
check('archive read only', ar.changed === 2, ar)
const archived = (await j('GET', '/inbox?view=archive'))[1]
check('archive view', archived.items.length === 2 && archived.items.every((i: any) => i.source === 'ranking'), archived.items.map((i: any) => i.source))
check('open view excludes archived', !(await j('GET', '/inbox'))[1].items.some((i: any) => i.source === 'ranking'))
const back = await j('POST', '/inbox/archive', { ids: [archived.items[0].id], archived: false })
check('unarchive', back[1].changed === 1, back)
// a new post under an archived tag starts a new item instead of reviving the old one
await j('POST', '/inbox/archive', { ids: [f1.id] })
const [, f4] = await j('POST', '/inbox', { source: 'odin', title: 'Disk at 95%', tag: 'disk', push: false })
check('archived twin not folded', f4.folded === false && f4.id !== f1.id, f4)

// sources
const src = (await j('GET', '/inbox'))[1].sources
const raid = src.find((x: any) => x.source === 'raid')
check('source stats', raid && raid.push === 'off' && raid.open === 2, src)

// limit and ordering: newest first
const lim = (await j('GET', '/inbox?limit=2'))[1].items
check('limit', lim.length === 2 && lim[0].lastAt >= lim[1].lastAt, lim)

console.log(`inbox smoke: ${pass} passed, ${fail} failed`)
srv.close(); process.exit(fail ? 1 : 0)
