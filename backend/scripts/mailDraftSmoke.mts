/**
 * Mail draft smoke test: the mail a proposal card shows (lib/mailDraft.ts) is the mail thor sends,
 * and a mail card is approved only with the draft it showed.
 *
 * Proposals and mail are written straight into a scratch store; nothing reaches thor, Autotask or
 * Claude (PROJECT_FILES_TOKEN is empty, so an approval queues the action and kicks nothing).
 *
 * Runs on thor or odin, against a scratch data dir:
 *   VALKYRIE_DATA_DIR=<scratch> npx tsx scripts/mailDraftSmoke.mts
 */
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'

const LIVE_DIR = path.join(homedir(), 'valkyrie', 'backend', 'data')
const real = (p: string) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }
const dataDir = process.env.VALKYRIE_DATA_DIR
if (!dataDir || real(dataDir) === real(LIVE_DIR)) {
  console.error('mailDraftSmoke: set VALKYRIE_DATA_DIR to a scratch directory')
  process.exit(2)
}
const conf = path.join(dataDir, 'mail-draft-conf')
fs.mkdirSync(conf, { recursive: true })
fs.writeFileSync(path.join(conf, 'work-agents.json'), JSON.stringify({
  franchises: [
    { key: 'east', label: 'East', company: 'East IT', envFile: 'autotask-east.env', web: 'https://ww5.autotask.net', brendonResource: 1001, supportCc: 'help@east.example', mailbox: 'me@east.example', ownDomains: ['east.example'], agent: { id: 'east-triage', name: 'East Triage', role: 'Tickets for East', topic: 'East tickets' }, brief: 'East.' },
  ],
  self: ['me@east.example'], mailboxRoutes: { 'east-support': 'east' }, defaultFranchise: 'east', teamsFranchise: null, skipDomains: [],
  mailOut: { from: 'Me@East.example', signature: 'Pat Example\r\nEast IT\n\nBook a time\n' },
}))
Object.assign(process.env, {
  VALKYRIE_CONF_DIR: conf, PROJECT_FILES_URL: 'http://127.0.0.1:9', PROJECT_FILES_TOKEN: '', AGENTS_DELAY_SCALE: '100000',
})

// imported only now: the stores open their databases and read the env at import time
const store = await import('../src/lib/agentsStore.ts')
const { mailDraft, proposalView } = await import('../src/lib/mailDraft.ts')
const { approveProposal } = await import('../src/lib/agentActions.ts')

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, got?: unknown) => {
  if (ok) { pass++; return }
  fail++
  console.log(`FAIL ${name}`, got === undefined ? '' : JSON.stringify(got, null, 1).slice(0, 900))
}
const refused = async (f: () => Promise<unknown>, status: number, re: RegExp) => {
  try { await f(); return false } catch (e) { return (e as { status?: number }).status === status && re.test((e as Error).message) }
}

const SEND_FROM = 'me@east.example'
const BODY = 'Hi Dana,\n\nSign out of the PDF app, then sign back in with the shared mailbox.'
const card = (kind: store.ProposalKind, payload: Record<string, unknown>) =>
  store.addProposal({ agentId: 'east-triage', channelId: 'east-triage', kind, title: `${kind} card`, payload })
const mail = (mailbox: string, address: string, graphId: string, toList: string, ccList: string) => store.addMail({
  mailbox, address, graphId, conversationId: 'c', subject: 'PDF app sign-in', fromName: 'Dana Park', fromAddress: 'dpark@beta.example',
  toList, ccList, receivedAt: new Date().toISOString(), body: 'It asks me to sign in.', webLink: null, importance: 'normal', focused: true, attachments: '',
})!

// ---------------------------------------------------------- new mail ---

const nm = card('mail_new', { franchise: 'east', from: 'me@east.example', to: ['dpark@beta.example'], cc: ['help@east.example'], subject: 'Your PDF app sign-in', body: `${BODY}\r\n` })
const dn = mailDraft(nm)!
check('new mail: from, to, cc, subject as sent', dn.from === 'me@east.example' && dn.to.join() === 'dpark@beta.example' && dn.cc.join() === 'help@east.example' && dn.subject === 'Your PDF app sign-in', dn)
check('new mail: the whole body, trimmed', dn.body === BODY && !dn.missing, dn.body)
check('closing and signature come with it', dn.closing === 'Thank you,' && new RegExp(dn.closingRe, 'i').test('Thanks!') && !new RegExp(dn.closingRe, 'i').test('See you then.')
  && dn.signature === 'Pat Example\nEast IT\n\nBook a time', dn)
check('the view carries the draft', proposalView(nm).draft?.body === BODY)

// ------------------------------------------------------- held replies ---

const held = mail('work', 'me@east.example', 'G1', 'me@east.example, Ann Lee <ann@beta.example>', 'bob@beta.example')
const rp = card('mail_reply', { franchise: 'east', n: held.n, to: 'dpark@beta.example', toName: 'Dana Park', subject: 'PDF app sign-in', cc: ['help@east.example'], replyAll: false, body: BODY })
const dr = mailDraft(rp)!
check('reply: from the mailbox it came to, to the sender, support cc', dr.from === 'me@east.example' && dr.to.join() === 'Dana Park <dpark@beta.example>' && dr.cc.join() === 'help@east.example' && dr.subject === 'RE: PDF app sign-in', dr)
const ra = card('mail_reply', { franchise: 'east', n: held.n, to: 'dpark@beta.example', toName: 'Dana Park', subject: 'Re: PDF app sign-in', cc: [], replyAll: true, body: BODY })
const dra = mailDraft(ra)!
check('reply-all: the sender and the message To in To, its Cc in Cc, less the mailbox', dra.to.join() === 'Dana Park <dpark@beta.example>,ann@beta.example' && dra.cc.join() === 'bob@beta.example' && !dra.ccNote && dra.subject === 'RE: PDF app sign-in', dra)

const sup = mail('east-support', 'help@east.example', 'G2', 'help@east.example', 'ann@beta.example, me@east.example')
const rs = card('mail_reply', { franchise: 'east', n: sup.n, to: 'dpark@beta.example', toName: 'Dana Park', subject: 'PDF app sign-in', cc: [], replyAll: true, body: BODY })
const drs = mailDraft(rs)!
check('support-box reply-all: from bkupsch, the sender in To, the rest in Cc less Brendon', drs.from === SEND_FROM && drs.to.join() === 'Dana Park <dpark@beta.example>' && drs.cc.join() === 'help@east.example,ann@beta.example', drs)

// ------------------------------------------------- replies read on thor ---

const live = card('mail_reply', { franchise: 'east', mailbox: 'me@east.example', messageId: 'M1', fromSupport: false, followUp: false, to: 'dpark@beta.example', toList: ['dpark@beta.example'], toName: 'Dana Park', subject: 'PDF app', cc: [], replyAll: true, threadTo: ['me@east.example'], threadCc: ['boss@beta.example'], body: BODY })
check('live reply-all lists the thread', mailDraft(live)!.to.join() === 'Dana Park <dpark@beta.example>' && mailDraft(live)!.cc.join() === 'boss@beta.example', mailDraft(live))
const old = card('mail_reply', { franchise: 'east', mailbox: 'me@east.example', messageId: 'M2', to: 'dpark@beta.example', toName: 'Dana Park', subject: 'PDF app', cc: [], replyAll: true, body: BODY })
check('an older reply-all card says who it reaches in words', mailDraft(old)!.ccNote === 'everyone else on the thread', mailDraft(old))
const fu = card('mail_reply', { franchise: 'east', mailbox: 'me@east.example', messageId: 'M3', followUp: true, to: 'dpark@beta.example, boss@beta.example', toList: ['dpark@beta.example', 'boss@beta.example'], subject: 'RE: PDF app update', cc: ['help@east.example'], replyAll: false, body: BODY })
const dfu = mailDraft(fu)!
check('follow-up: to its recipients, from bkupsch, one RE:', dfu.from === SEND_FROM && dfu.to.join() === 'dpark@beta.example,boss@beta.example' && dfu.cc.join() === 'help@east.example' && dfu.subject === 'RE: PDF app update', dfu)

// ------------------------------------------------------- not mail ---

const note = card('ticket_note', { franchise: 'east', ticketId: 1, number: 'T1', title: 'x', text: 'y' })
check('a ticket card has no draft', mailDraft(note) === null && !('draft' in proposalView(note)))

// ------------------------------------------------------- approving ---

const empty = card('mail_new', { franchise: 'east', from: 'me@east.example', to: ['dpark@beta.example'], cc: [], subject: 'Nothing', body: '' })
check('no body stored: draft missing', mailDraft(empty)!.missing === true)
check('draft missing is never approvable', await refused(() => approveProposal(empty.id, { how: 'send', body: BODY }), 409, /draft missing/) && store.getProposal(empty.id)?.status === 'pending')
check('an approval without the draft it showed is refused', await refused(() => approveProposal(nm.id, { how: 'send' }), 409, /did not show the draft/) && store.getProposal(nm.id)?.status === 'pending')
check('an emptied draft is refused', await refused(() => approveProposal(nm.id, { how: 'send', body: '  \n ' }), 400, /empty/) && store.getProposal(nm.id)?.status === 'pending')
const edited = `${BODY}\n\nEdited on the card.`
const ap = await approveProposal(nm.id, { how: 'send', body: edited })
const queued = store.claimActions('thor').find((a) => a.proposalId === nm.id)
check('the approved text is what thor sends', ap.status === 'running' && queued?.kind === 'mail_new' && queued.payload.body === edited, { ap, queued })

console.log(`mailDraftSmoke: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
