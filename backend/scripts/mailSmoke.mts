/**
 * Mail smoke test: routes/mail.ts with routes/inbox.ts over a scratch data dir.
 *
 * A first sync posts only NEW unread Focused mail of the last day to the inbox (no push), skips
 * Other, read and older mail, keeps the unread count; a later sync that sees a message read in
 * Outlook marks its inbox item read; an error sync is kept as the mailbox's error; validation; and the
 * Cloudflare rule: a private mailbox, its rows and its inbox items (list, count, sources) answer like
 * they do not exist, while a non-private one stays visible.
 *
 *   VALKYRIE_DATA_DIR=$(mktemp -d) node --import tsx scripts/mailSmoke.mts
 */
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'

const LIVE_DIR = path.join(homedir(), 'valkyrie', 'backend', 'data')
const dataDir = process.env.VALKYRIE_DATA_DIR
if (!dataDir || fs.realpathSync(dataDir) === (() => { try { return fs.realpathSync(LIVE_DIR) } catch { return LIVE_DIR } })()) {
  console.error('mailSmoke: set VALKYRIE_DATA_DIR to a scratch directory')
  process.exit(2)
}
delete process.env.VAPID_PUBLIC_KEY
delete process.env.VAPID_PRIVATE_KEY

const app = express(); app.use(express.json({ limit: '2mb' }))
for (const r of ['mail', 'inbox']) app.use('/api', (await import(`../src/routes/${r}.ts`)).default)
const srv = app.listen(0); const port = (srv.address() as { port: number }).port
const base = `http://127.0.0.1:${port}/api`
const j = async (m: string, p: string, b?: unknown, cf = false) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (cf) headers['cf-ray'] = 'smoke'
  const r = await fetch(base + p, { method: m, headers, body: b ? JSON.stringify(b) : undefined })
  return [r.status, await r.json()] as [number, any]
}
let pass = 0, fail = 0
const check = (name: string, ok: boolean, got?: unknown) => {
  if (ok) pass += 1
  else { fail += 1; console.log('FAIL', name, JSON.stringify(got)?.slice(0, 400)) }
}

const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()
const msg = (id: string, over: Record<string, unknown> = {}) => ({
  id, subject: `Subject ${id}`, fromName: `Sender ${id}`, fromAddress: `${id}@example.com`, receivedAt: ago(1),
  isRead: false, preview: `Preview of ${id}`, webLink: `https://outlook.office365.com/owa/?ItemID=${id}`, importance: 'normal', flagged: false, focused: true, ...over,
})
const work = { key: 'work', label: 'Work mail', source: 'work-mail', private: true }

// the first sync
let [st, r] = await j('POST', '/mail/sync', {
  mailbox: work, unread: 4, total: 900,
  messages: [msg('a'), msg('b', { focused: false }), msg('c', { isRead: true }), msg('d', { receivedAt: ago(30) }), msg('e', { importance: 'high' })],
})
check('first sync', st === 200 && r.added === 2 && r.known === 0, r)
let items = (await j('GET', '/inbox?source=work-mail'))[1].items
check('only new unread Focused mail of the last day', items.length === 2 && items.every((i: any) => i.pushDetail === null), items)
const a = items.find((i: any) => i.title === 'Sender a: Subject a')
check('item shape', a && a.body === 'Preview of a' && a.url === 'https://outlook.office365.com/owa/?ItemID=a' && a.level === 'info', a)
check('high importance is warn but still no push', items.find((i: any) => i.title.startsWith('Sender e'))?.level === 'warn', items)

let mail = (await j('GET', '/mail'))[1]
check('mailbox listed', mail.mailboxes.length === 1 && mail.mailboxes[0].unread === 4 && mail.mailboxes[0].label === 'Work mail' && !mail.mailboxes[0].stale, mail.mailboxes)
check('unread Focused of 3 days', mail.unread.map((m: any) => m.subject).sort().join('|') === 'Subject a|Subject d|Subject e', mail.unread.map((m: any) => m.subject))

// a second sync: a read in Outlook, nothing new added twice
;[st, r] = await j('POST', '/mail/sync', { mailbox: work, unread: 3, total: 900, messages: [msg('a', { isRead: true }), msg('e'), msg('f')] })
check('second sync', st === 200 && r.added === 1 && r.known === 2 && r.markedRead === 1, r)
items = (await j('GET', '/inbox?source=work-mail'))[1].items
check('read in Outlook, read here', items.find((i: any) => i.title === 'Sender a: Subject a')?.readAt !== null, items)
check('no duplicate items', items.filter((i: any) => i.title.startsWith('Sender e')).length === 1 && items.length === 3, items.map((i: any) => i.title))

// Cloudflare: the private mailbox is gone everywhere
check('cf hides the mailbox', (await j('GET', '/mail', undefined, true))[1].mailboxes.length === 0)
check('cf hides its mail', (await j('GET', '/mail', undefined, true))[1].unread.length === 0)
const cfInbox = (await j('GET', '/inbox', undefined, true))[1]
check('cf hides its inbox items, count and source', cfInbox.items.length === 0 && cfInbox.count.unread === 0 && !cfInbox.sources.some((s: any) => s.source === 'work-mail'), cfInbox)
check('cf count endpoint', (await j('GET', '/inbox/count', undefined, true))[1].unread === 0)
check('tailnet still sees them', (await j('GET', '/inbox/count'))[1].unread === 2)

// a non-private mailbox stays visible through Cloudflare
await j('POST', '/mail/sync', { mailbox: { key: 'home', label: 'Home', source: 'home-mail', private: false }, unread: 1, total: 5, messages: [msg('h')] })
check('non-private visible on cf', (await j('GET', '/mail', undefined, true))[1].mailboxes.map((b: any) => b.key).join() === 'home')
check('non-private items visible on cf', (await j('GET', '/inbox', undefined, true))[1].items.some((i: any) => i.source === 'home-mail'))

// an error sync keeps the last count and says what failed
;[st, r] = await j('POST', '/mail/sync', { mailbox: work, error: 'Graph 401: token expired' })
mail = (await j('GET', '/mail'))[1]
const w = mail.mailboxes.find((b: any) => b.key === 'work')
check('error kept', st === 200 && w.error === 'Graph 401: token expired' && w.unread === 3, w)
await j('POST', '/mail/sync', { mailbox: work, unread: 2, total: 900, messages: [] })
check('error clears on the next good sync', (await j('GET', '/mail'))[1].mailboxes.find((b: any) => b.key === 'work').error === null)

// validation
check('bad key', (await j('POST', '/mail/sync', { mailbox: { key: 'Bad Key', source: 'x' } }))[0] === 400)
check('bad source', (await j('POST', '/mail/sync', { mailbox: { key: 'ok', source: 'Bad Source' } }))[0] === 400)
;[st, r] = await j('POST', '/mail/sync', { mailbox: work, unread: 0, messages: [{ id: '', receivedAt: 'x' }, { id: 'z', receivedAt: 'not a date' }, msg('j', { webLink: 'javascript:alert(1)' })] })
check('junk rows skipped, bad links dropped', st === 200 && r.added === 1, r)
const jItem = (await j('GET', '/inbox?source=work-mail'))[1].items.find((i: any) => i.title.startsWith('Sender j'))
check('no link kept', jItem && jItem.url === null, jItem)

console.log(`mail smoke: ${pass} passed, ${fail} failed`)
srv.close(); process.exit(fail ? 1 : 0)
