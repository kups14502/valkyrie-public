/**
 * Mail smoke test: routes/mail.ts with routes/inbox.ts over a scratch data dir.
 *
 * A first sync posts only NEW unread Focused mail of the last day to the inbox (no push), skips
 * Other, read and older mail, keeps the unread count; a later sync that sees a message read in
 * Outlook marks its inbox item read; an error sync is kept as the mailbox's error; validation; and the
 * Cloudflare rule: a private mailbox, its rows and its inbox items (list, count, sources) answer like
 * they do not exist, while a non-private one stays visible. Mail no person wrote (noreply senders,
 * bulk subdomains, meeting replies, ticket notifications) adds no inbox item, nor does mail a
 * feature's filter matches (addMailFilters, which also archives what such mail made before), and a
 * message in two mailboxes is one item.
 *
 * The body (2026-11-20): a mail.sqlite from before it gains the body and webUrl columns in place
 * with its rows kept; a sync's body is stored tidied (line breaks kept, capped at 16000) and served
 * one item at a time by GET /api/mail/item/:inboxId, never in GET /api/mail or the inbox items; a
 * row first synced without one takes it from a later sync, once; the mailbox's webUrl is its web
 * mail (iCloud), not the message's link; private mail answers 404 through Cloudflare.
 *
 *   VALKYRIE_DATA_DIR=$(mktemp -d) node --import tsx scripts/mailSmoke.mts
 */
import Database from 'better-sqlite3'
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'

const LIVE_DIR = path.join(homedir(), 'valkyrie', 'backend', 'data')
const dataDir = process.env.VALKYRIE_DATA_DIR
// a fresh scratch path may not exist yet (the lane's smoke names one); realpath needs it to
if (dataDir) fs.mkdirSync(dataDir, { recursive: true })
if (!dataDir || fs.realpathSync(dataDir) === (() => { try { return fs.realpathSync(LIVE_DIR) } catch { return LIVE_DIR } })()) {
  console.error('mailSmoke: set VALKYRIE_DATA_DIR to a scratch directory')
  process.exit(2)
}
delete process.env.VAPID_PUBLIC_KEY
delete process.env.VAPID_PRIVATE_KEY

// a mail.sqlite as the store left it before the body: the store must add its columns in place
const dbFile = path.join(dataDir, 'mail.sqlite')
{
  const old = new Database(dbFile)
  old.exec(`
    CREATE TABLE mailboxes (key TEXT PRIMARY KEY, label TEXT NOT NULL, source TEXT NOT NULL, private INTEGER NOT NULL DEFAULT 1,
      unread INTEGER, total INTEGER, syncedAt TEXT, error TEXT, errorAt TEXT);
    CREATE TABLE mail_messages (mailbox TEXT NOT NULL, id TEXT NOT NULL, fromName TEXT NOT NULL DEFAULT '', fromAddress TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '', preview TEXT NOT NULL DEFAULT '', receivedAt TEXT NOT NULL, isRead INTEGER NOT NULL, webLink TEXT,
      importance TEXT NOT NULL DEFAULT 'normal', flagged INTEGER NOT NULL DEFAULT 0, focused INTEGER NOT NULL DEFAULT 1, inboxId INTEGER,
      firstSeenAt TEXT NOT NULL, PRIMARY KEY (mailbox, id));
  `)
  old.prepare(`INSERT INTO mail_messages (mailbox, id, fromName, fromAddress, subject, preview, receivedAt, isRead, firstSeenAt)
    VALUES ('legacy', 'old-1', 'Old Sender', 'old@example.org', 'Kept through the migration', 'Old preview', ?, 1, ?)`)
    .run(new Date(Date.now() - 2 * 3_600_000).toISOString(), new Date().toISOString())
  old.close()
}

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

// only mail a person wrote becomes an inbox item (2026-11-01)
const { automated } = await import('../src/lib/mailStore.ts')
const auto = (fromAddress: string, subject = 'Hello') => automated({ fromAddress, subject })
check('noreply senders are automated', ['no_reply@post.example.apple', 'no-reply@example.com', 'donotreply@example.com', 'newsletter@example.com', 'order-update@example.com', 'replies@m.example.com'].every((s) => auto(s)))
check('bulk sending subdomains are automated', ['brand@account.example.com', 'careers@talent.mail.example.com', 'advisors@consult.example.com'].every((s) => auto(s)))
check('meeting replies and ticket notifications are automated', auto('person@example.com', 'Accepted: Project: next steps')
  && auto('support@example.com', 'Ticket Note Note Created: T20261030.0003 - printer') && auto('person@example.com', 'Tentative: sync'))
check('people are not automated', !auto('jane.doe@example.com', 'Re: T20261030.0003 - Terminal opening at PC start')
  && !auto('DEO@EXAMPLE.COM', 'Fw: Welcome to your account') && !auto('jlin@example.org', 'Re: Email on your phone')
  && !auto('person@sub.example.com', 'Canceled: Monday sync'))
;[st, r] = await j('POST', '/mail/sync', { mailbox: work, unread: 2, messages: [
  msg('n1', { fromAddress: 'newsletter@example.com' }), msg('n2', { subject: 'Accepted: Project kickoff' }),
] })
check('automated mail is kept but adds no inbox item', st === 200 && r.added === 0 && r.known === 0, r)

// a feature's mail filter keeps the mail it matches out of the inbox, and archives the items that mail made before
const { addMailFilters } = await import('../src/lib/mailStore.ts')
;[st, r] = await j('POST', '/mail/sync', { mailbox: work, unread: 2, messages: [msg('q0', { subject: '[quiet] before the filter' })] })
check('mail is an inbox item before a filter matches it', st === 200 && r.added === 1, r)
const q0 = (await j('GET', '/inbox?source=work-mail'))[1].items.find((i: any) => i.title === 'Sender q0: [quiet] before the filter')
addMailFilters([(m) => m.subject.startsWith('[quiet]')])
check('a new filter archives the items its mail made', Boolean(q0)
  && !(await j('GET', '/inbox?source=work-mail'))[1].items.some((i: any) => i.id === q0.id)
  && (await j('GET', '/inbox?source=work-mail&view=archive'))[1].items.some((i: any) => i.id === q0.id), q0)
;[st, r] = await j('POST', '/mail/sync', { mailbox: work, unread: 2, messages: [
  msg('q1', { subject: '[quiet] kept in Mail' }), msg('q2', { subject: 'Next steps' }),
] })
check('filtered mail adds no inbox item, other mail does', st === 200 && r.added === 1, r)
check('filtered mail stays in Mail', (await j('GET', '/mail'))[1].unread.some((m: any) => m.subject === '[quiet] kept in Mail'))
const support = { key: 'support', label: 'Support', source: 'support-mail', private: true }
const shared = msg('p2', { fromAddress: 'person@example.org', subject: 'Re: shared', receivedAt: ago(1) })
await j('POST', '/mail/sync', { mailbox: work, unread: 1, messages: [{ ...shared, id: 'p2-work' }] })
;[st, r] = await j('POST', '/mail/sync', { mailbox: support, unread: 1, messages: [{ ...shared, id: 'p2-support' }] })
check('mail CC\'d to two mailboxes is one inbox item', st === 200 && r.added === 0
  && (await j('GET', '/inbox'))[1].items.filter((i: any) => i.title === 'Sender p2: Re: shared').length === 1, r)

// the body (2026-11-20): the migration kept the old row and added the columns
const peek = new Database(dbFile, { readonly: true })
const cols = (t: string) => (peek.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)
check('the migration adds the body and webUrl columns', cols('mail_messages').includes('body') && cols('mailboxes').includes('webUrl'), [cols('mail_messages'), cols('mailboxes')])
const legacy = () => peek.prepare("SELECT subject, body FROM mail_messages WHERE mailbox = 'legacy' AND id = 'old-1'").get() as { subject: string; body: string | null } | undefined
check('the migration keeps the rows it found', legacy()?.subject === 'Kept through the migration' && legacy()?.body === null, legacy())

const itemId = async (title: string, source = 'work-mail') => (await j('GET', `/inbox?source=${source}`))[1].items.find((i: any) => i.title === title)?.id as number | undefined
const longBody = `Hi Alex,\r\n\r\n\r\n\r\nThe whole message, line by line.\u0007   \r\n${'More text. '.repeat(2000)}`
const icloud = { key: 'icloud', label: 'iCloud', source: 'personal-mail', private: true, webUrl: 'https://www.icloud.com/mail/' }
;[st, r] = await j('POST', '/mail/sync', { mailbox: icloud, unread: 1, total: 10, messages: [
  msg('b1', { webLink: 'https://www.icloud.com/mail/', preview: 'Hi Alex, The whole message', body: longBody }),
] })
check('a sync with a body', st === 200 && r.added === 1, r)
const b1 = await itemId('Sender b1: Subject b1', 'personal-mail')
let [ist, mi] = await j('GET', `/mail/item/${b1}`)
check('the item serves its whole body, tidied', ist === 200 && typeof mi.body === 'string' && mi.body.startsWith('Hi Alex,\n\nThe whole message, line by line.\nMore text.')
  && !/[\r\u0007]/.test(mi.body) && mi.body.length === 16000, { ist, start: mi.body?.slice(0, 80), len: mi.body?.length })
check('a mailbox web mail is not the message\'s link', mi.webLink === null && mi.web === 'https://www.icloud.com/mail/' && mi.label === 'iCloud'
  && mi.fromName === 'Sender b1' && mi.subject === 'Subject b1' && mi.preview === 'Hi Alex, The whole message', mi)
check('private mail is not served through Cloudflare', (await j('GET', `/mail/item/${b1}`, undefined, true))[0] === 404)
const b1Item = (await j('GET', '/inbox?source=personal-mail'))[1].items.find((i: any) => i.id === b1)
check('the inbox item keeps only the preview', b1Item?.body === 'Hi Alex, The whole message', b1Item?.body?.length)
const list = (await j('GET', '/mail'))[1]
check('the mail list never carries a body', list.unread.length > 0 && list.unread.every((m: any) => !('body' in m)) && JSON.stringify(list).length < 20_000, JSON.stringify(list).length)
check('the mailbox list has no webUrl or body either', list.mailboxes.every((b: any) => !('webUrl' in b) && !('body' in b)), list.mailboxes)

// a message with its own link (Outlook): Open is that link, and there is no web mail beside it
;[st, r] = await j('POST', '/mail/sync', { mailbox: work, unread: 1, messages: [msg('b2', { body: 'Outlook body\n\n> quoted' })] })
const b2 = await itemId('Sender b2: Subject b2')
;[ist, mi] = await j('GET', `/mail/item/${b2}`)
check('a message\'s own link', ist === 200 && mi.webLink === 'https://outlook.office365.com/owa/?ItemID=b2' && mi.web === null && mi.body === 'Outlook body\n\n> quoted', mi)

// a row first synced without a body takes it from a later sync, once
const f = await itemId('Sender f: Subject f')
;[ist, mi] = await j('GET', `/mail/item/${f}`)
check('a row from before the body serves the preview and no body', ist === 200 && mi.body === null && mi.preview === 'Preview of f', mi)
;[st, r] = await j('POST', '/mail/sync', { mailbox: work, unread: 1, messages: [msg('f', { body: 'The full text of f' })] })
check('a later sync fills it', st === 200 && r.known === 1 && (await j('GET', `/mail/item/${f}`))[1].body === 'The full text of f', r)
await j('POST', '/mail/sync', { mailbox: work, unread: 1, messages: [msg('f', { body: 'Something else' })] })
check('and never overwrites it', (await j('GET', `/mail/item/${f}`))[1].body === 'The full text of f')
await j('POST', '/mail/sync', { mailbox: { key: 'legacy', label: 'Legacy', source: 'legacy-mail', private: true }, unread: 0, messages: [
  msg('old-1', { isRead: true, receivedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), body: 'The old row\'s text' }),
] })
check('a migrated row takes its body too', legacy()?.body === 'The old row\'s text', legacy())
check('a body that is not text is ignored', (await j('POST', '/mail/sync', { mailbox: work, unread: 1, messages: [msg('b3', { body: { html: '<p>x</p>' } })] }))[0] === 200
  && (await j('GET', `/mail/item/${await itemId('Sender b3: Subject b3')}`))[1].body === null)
check('an item with no mail behind it is 404', (await j('GET', '/mail/item/999999'))[0] === 404)
check('a bad item id is 400', (await j('GET', '/mail/item/abc'))[0] === 400 && (await j('GET', '/mail/item/0'))[0] === 400)
peek.close()

console.log(`mail smoke: ${pass} passed, ${fail} failed`)
srv.close(); process.exit(fail ? 1 : 0)
