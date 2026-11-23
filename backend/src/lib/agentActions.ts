import {
  addEvent, addMessage, addProposal, AgentError, finishAction, getAgent, getMail, getProposal, mailByGraphId, markSelfTouch, moveProposal,
  pendingProposals, queueAction, recentMailFrom, setMailState, setProposalMessage, trackedTicket, type Agent, type Proposal, type ProposalKind, type Ref,
} from './agentsStore.js'
import {
  addInternalNote, addTimeEntry, createTicket, franchiseLabel, planTicketUpdate, planTimeEntry, PsaError, ticketUrl, updateTicket,
  type Franchise, type TicketPatch, type TimeEntryInput,
} from './psa.js'
import { agentPost, etLabel, systemPost, wake } from './agents.js'
import { franchiseConf, workConf } from './workConfig.js'
import { featureAgent } from './featureAgents.js'
import { kickThor, mailboxRead } from './thorMail.js'
import { draftBody, isMissing } from './mailDraft.js'

// Proposals: what an agent wants done in the outside world, waiting on
// Brendon. Each one is approved by itself (approval of one email is never
// approval of the next). On approval Valkyrie does it at once, not the agent:
//   ticket_note / ticket_update / ticket_create  Autotask, from odin (lib/psa.ts)
//   ticket_time                                  a time entry as Brendon
//   ticket_complete                              an internal note, optional time,
//                                                then Complete with the resolution
//   mail_reply / mail_new                        queued for thor, which sends with
//                                                clientmail.ps1 (the certificate
//                                                never leaves thor, and its send
//                                                ledger refuses a duplicate within
//                                                24 hours); thor is started at once
//   feature                                      the feature agent's own action
//                                                (lib/featureAgents.ts), in the API

/** The address a reply copies by default: the franchise's support queue. */
const supportCc = (f: Franchise): string[] => {
  const cc = franchiseConf(f)?.supportCc
  return cc ? [cc] : []
}

const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[a-z]{2,}$/i

function addresses(list: string[] | undefined): string[] {
  const out: string[] = []
  for (const raw of list ?? []) {
    const x = raw.trim().replace(/^.*<([^>]+)>\s*$/, '$1').trim()
    if (!x) continue
    if (!EMAIL_RE.test(x)) throw new AgentError(400, `not an address: ${raw}`)
    if (!out.some((y) => y.toLowerCase() === x.toLowerCase())) out.push(x)
  }
  return out
}

function draftText(body: string): string {
  const b = body.replace(/\r\n/g, '\n').trim()
  if (b.length < 10) throw new AgentError(400, 'the draft is empty')
  if (/[—]/.test(b)) throw new AgentError(400, 'the draft has an em dash; rewrite it with commas, parentheses or colons')
  return b
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** The franchise of a triage agent, or why it may not do this. */
function triageFranchise(agent: Agent, what: string): Franchise {
  if (!agent.franchise || agent.kind !== 'triage') throw new AgentError(403, `only the triage agents ${what}`)
  return agent.franchise as Franchise
}

/** Brendon's mailbox for this triage agent, and its support box: the two thor reads. */
function mailboxes(agent: Agent): { mine: string; support: string } {
  const conf = franchiseConf(agent.franchise)
  if (agent.kind !== 'triage' || !conf?.mailbox) throw new AgentError(403, `${agent.name} has no mailbox access (work-agents.json "mailbox")`)
  return { mine: conf.mailbox, support: (conf.supportCc || '').toLowerCase() }
}

// ------------------------------------------------------------- create ----

function post(agent: Agent, kind: ProposalKind, title: string, payload: Record<string, unknown>, text: string, refs: Ref[], hop: number): Proposal {
  const p = addProposal({ agentId: agent.id, channelId: agent.channelId, kind, title, payload })
  const msg = agentPost(agent, agent.channelId, text, { refs, notify: true, hop, proposalId: p.id })
  setProposalMessage(p.id, msg.id)
  return getProposal(p.id)!
}

export type MailReplyArgs = {
  n?: number; messageId?: string; mailbox?: 'mine' | 'support'
  body: string; replyAll?: boolean; cc?: string[]; note?: string
}

/**
 * A reply in someone's own thread: to a mail Valkyrie holds (n), or to any message in Brendon's
 * mailbox or the support box (messageId, from mailbox_search), read live on thor so the card
 * shows who it really goes to. A message Brendon sent himself is followed up in its thread, to
 * its own recipients.
 */
export async function proposeMailReply(agent: Agent, a: MailReplyArgs, hop: number): Promise<Proposal> {
  const body = draftText(a.body)
  const note = (a.note ?? '').slice(0, 600)
  if (a.n === undefined && !a.messageId) throw new AgentError(400, 'name the mail to reply to: n (a mail Valkyrie holds) or messageId (from mailbox_search)')

  if (a.n !== undefined) {
    const mail = getMail(a.n)
    if (!mail) throw new AgentError(404, `no mail #${a.n}`)
    const franchise = (mail.franchise ?? agent.franchise) as Franchise | null
    if (!franchise) throw new AgentError(400, 'this mail has no franchise yet; only the triage agents reply to work mail')
    if (agent.franchise !== franchise) throw new AgentError(403, `mail #${a.n} belongs to ${franchiseLabel(franchise)}; hand it to that triage agent`)
    const cc = addresses(a.cc ?? supportCc(franchise))
    const payload = {
      n: mail.n, franchise, body, replyAll: Boolean(a.replyAll), cc: a.replyAll ? [] : cc, note,
      to: mail.fromAddress, toName: mail.fromName, subject: mail.subject,
    }
    const title = `Reply to ${mail.fromName || mail.fromAddress}: ${mail.subject || '(no subject)'}`
    const text = note.trim() || `Draft reply to ${mail.fromName || mail.fromAddress} for your approval.`
    return post(agent, 'mail_reply', title, payload, text, [{ type: 'mail', n: mail.n, subject: mail.subject, from: mail.fromName || mail.fromAddress, url: mail.webLink ?? undefined }], hop)
  }

  const f = triageFranchise(agent, 'reply to work mail')
  const boxes = mailboxes(agent)
  const address = a.mailbox === 'support' ? boxes.support : boxes.mine
  if (!address) throw new AgentError(400, 'this franchise has no support mailbox')
  const m = await mailboxRead(address, String(a.messageId).trim())
  const held = mailByGraphId(address, m.messageId)
  if (held?.franchise && held.franchise !== f) throw new AgentError(403, `that mail belongs to ${franchiseLabel(held.franchise)}; hand it to that triage agent`)
  const self = new Set([boxes.mine, ...workConf().self].map((x) => x.toLowerCase()))
  const own = self.has(m.from.toLowerCase())
  const replyAll = Boolean(a.replyAll)
  let to: string[]
  let cc: string[]
  if (own) {
    // Brendon's own message: the follow-up goes to the people it went to, in its thread
    to = m.to.filter((x) => !self.has(x.toLowerCase()))
    if (!to.length) throw new AgentError(400, 'that message went only to Brendon himself; there is nobody to follow up with')
    cc = replyAll ? m.cc.filter((x) => !self.has(x.toLowerCase())) : addresses(a.cc ?? supportCc(f))
  } else {
    to = [m.from]
    cc = replyAll ? [] : addresses(a.cc ?? supportCc(f))
  }
  const payload = {
    franchise: f, body, note, replyAll: replyAll && !own, cc,
    mailbox: address, messageId: m.messageId, fromSupport: address === boxes.support && !own, followUp: own,
    to: to.join(', '), toList: to, toName: own ? '' : m.fromName, subject: m.subject, received: m.received,
    // the message's own people, so a reply-all card lists who it reaches (lib/mailDraft.ts)
    threadTo: m.to, threadCc: m.cc,
    ...(held ? { n: held.n } : {}),
  }
  const who = own ? to.join(', ') : m.fromName || m.from
  const title = `${own ? 'Follow-up' : 'Reply'} to ${who}: ${m.subject || '(no subject)'}`
  const text = note.trim() || `Draft ${own ? 'follow-up' : 'reply'} to ${who} for your approval.`
  const refs: Ref[] = held ? [{ type: 'mail', n: held.n, subject: held.subject, from: held.fromName || held.fromAddress, url: held.webLink ?? undefined }] : []
  return post(agent, 'mail_reply', title, payload, text, refs, hop)
}

export type MailNewArgs = { to: string[]; cc?: string[]; subject: string; body: string; note?: string; ticketId?: number; number?: string; newThread?: boolean }

/** A new mail from Brendon's mailbox, for when there is no thread to reply in. */
export function proposeMailNew(agent: Agent, a: MailNewArgs, hop: number): Proposal {
  const f = triageFranchise(agent, 'send new mail')
  const boxes = mailboxes(agent)
  const to = addresses(a.to)
  if (!to.length) throw new AgentError(400, 'a new mail needs at least one To address')
  const cc = addresses(a.cc ?? supportCc(f))
  if (to.length + cc.length > 12) throw new AgentError(400, 'at most 12 recipients')
  const subject = a.subject.replace(/\s+/g, ' ').trim().slice(0, 250)
  if (!subject) throw new AgentError(400, 'a new mail needs a subject')
  const body = draftText(a.body)
  if (!a.newThread) {
    // the house rule: when they wrote to us, the answer goes in their thread
    const prior = recentMailFrom(to)
    if (prior) {
      throw new AgentError(409, `${prior.fromName || prior.fromAddress} wrote on ${etLabel(prior.receivedAt)} ("${clip(prior.subject, 80)}", mail #${prior.n}). `
        + `Reply in that thread with propose_mail_reply n ${prior.n}; pass newThread true only when this is a different matter.`)
    }
  }
  const refs: Ref[] = []
  if (a.ticketId) refs.push(ticketRef(f, a.ticketId, a.number).ref)
  const note = (a.note ?? '').slice(0, 600)
  const payload = { franchise: f, from: boxes.mine, to, cc, subject, body, note, ...(a.ticketId ? { ticketId: a.ticketId } : {}) }
  return post(agent, 'mail_new', `New mail to ${clip(to.join(', '), 80)}: ${subject}`, payload,
    note.trim() || `New mail to ${to[0]} for your approval.`, refs, hop)
}

/** The ticket a proposal is about, named by its number (agents often pass only the id). */
function ticketRef(f: Franchise, id: number, number?: string): { number: string; ref: Ref } {
  const tr = trackedTicket(f, id)
  const num = number?.trim() || tr?.number || String(id)
  return { number: num, ref: { type: 'ticket', franchise: f, id, number: num, title: tr?.title, url: ticketUrl(f, id) } }
}

export function proposeTicketNote(agent: Agent, a: { ticketId: number; number?: string; title: string; text: string; why?: string }, hop: number): Proposal {
  const f = triageFranchise(agent, 'propose ticket notes')
  const t = ticketRef(f, a.ticketId, a.number)
  const payload = { franchise: f, ticketId: a.ticketId, number: t.number, title: a.title.slice(0, 250), text: a.text.slice(0, 8000) }
  return post(agent, 'ticket_note', `Internal note on ${t.number}: ${a.title}`, payload,
    a.why?.trim() || 'An internal note for your approval.', [t.ref], hop)
}

/** "company Beta Org, contact Dana Park" from the plan's lines (side effects left out). */
const changeSummary = (changes: string[]) => clip(changes
  .filter((l) => !/^(Contract|Configuration item): cleared/.test(l))
  .map((l) => {
    const m = /^([^:]+): (.*?)(?: \(was .*\))?$/s.exec(l)
    return m ? `${m[1].toLowerCase().replace(/, new$/, '')} ${clip(m[2].replace(/\s+/g, ' '), 50)}` : l
  })
  .join(', '), 200)

const PATCH_KEYS = ['status', 'priority', 'queue', 'assignToBrendon', 'assignTo', 'due', 'companyId', 'contactId', 'title', 'description', 'resolution'] as const

function patchOf(a: Record<string, unknown>): TicketPatch {
  const out: Record<string, unknown> = {}
  for (const k of PATCH_KEYS) if (a[k] !== undefined && a[k] !== '') out[k] = a[k]
  if (out.assignToBrendon === false) delete out.assignToBrendon
  return out as TicketPatch
}

export async function proposeTicketUpdate(agent: Agent, a: { ticketId: number; number?: string; why: string } & TicketPatch, hop: number): Promise<Proposal> {
  const f = triageFranchise(agent, 'propose ticket changes')
  const patch = patchOf(a as unknown as Record<string, unknown>)
  if (!Object.keys(patch).length) throw new AgentError(400, 'nothing to change')
  const plan = await planTicketUpdate(f, a.ticketId, patch)
  if (!plan.changes.length) throw new AgentError(400, `nothing to change: ${plan.number} already is that way`)
  const t = ticketRef(f, a.ticketId, plan.number)
  const payload = { franchise: f, ticketId: a.ticketId, number: plan.number, patch, changes: plan.changes, closes: plan.closes }
  return post(agent, 'ticket_update', `${plan.number}: ${changeSummary(plan.changes)}`, payload,
    `${a.why.trim()}${plan.closes ? '\n\nCompleting it emails the contact the resolution.' : ''}`, [t.ref], hop)
}

export async function proposeTimeEntry(agent: Agent, a: { ticketId: number; number?: string; why?: string } & TimeEntryInput, hop: number): Promise<Proposal> {
  const f = triageFranchise(agent, 'propose time entries')
  const entry: TimeEntryInput = {
    hours: a.hours, summary: a.summary, internalNotes: a.internalNotes, workType: a.workType, start: a.start, nonBillable: a.nonBillable,
  }
  const plan = await planTimeEntry(f, a.ticketId, entry)
  entry.start = plan.start // the times on the card are the times that get logged
  const t = ticketRef(f, a.ticketId, plan.number)
  const payload = { franchise: f, ticketId: a.ticketId, number: plan.number, entry, changes: plan.changes }
  return post(agent, 'ticket_time', `${plan.number}: log ${plan.body.hoursWorked} h`, payload,
    a.why?.trim() || 'A time entry for your approval.', [t.ref], hop)
}

export type CompleteArgs = {
  ticketId: number; number?: string; note: string; noteTitle?: string; resolution?: string
  hours?: number; workType?: string; start?: string; why?: string
}

/** Complete a ticket: an internal note of what was done, time if any, then Complete with the resolution the contact reads. */
export async function proposeTicketComplete(agent: Agent, a: CompleteArgs, hop: number): Promise<Proposal> {
  const f = triageFranchise(agent, 'propose completing tickets')
  const note = a.note.trim()
  if (note.length < 10) throw new AgentError(400, 'say what was done in the note')
  const resolution = (a.resolution ?? '').trim() || note
  const plan = await planTicketUpdate(f, a.ticketId, { status: 'Complete', resolution })
  if (!plan.changes.some((l) => l.startsWith('Status:'))) throw new AgentError(400, `${plan.number} is already Complete`)
  const lines = [`Internal note, ${(a.noteTitle ?? '').trim() || 'Resolution'}: ${clip(note, 600)}`]
  let entry: TimeEntryInput | undefined
  if (a.hours) {
    entry = { hours: a.hours, summary: note, workType: a.workType, start: a.start }
    const tp = await planTimeEntry(f, a.ticketId, entry)
    entry.start = tp.start
    lines.push(...tp.changes.filter((l) => !l.startsWith('Summary:')))
  }
  lines.push(...plan.changes)
  const t = ticketRef(f, a.ticketId, plan.number)
  const payload = {
    franchise: f, ticketId: a.ticketId, number: plan.number, note, noteTitle: (a.noteTitle ?? '').trim().slice(0, 250) || 'Resolution',
    resolution, ...(entry ? { entry } : {}), changes: lines, done: [] as string[],
  }
  return post(agent, 'ticket_complete', `${plan.number}: complete${entry ? `, log ${entry.hours} h` : ''}`, payload,
    `${(a.why ?? '').trim() || 'Ready to complete.'}\n\nCompleting it emails the contact the resolution.`, [t.ref], hop)
}

export function proposeTicketCreate(agent: Agent, a: { companyId: number; company: string; title: string; description: string; priority?: string; queue?: string; contactId?: number; contact?: string; n?: number; why?: string }, hop: number): Proposal {
  const f = triageFranchise(agent, 'propose new tickets')
  const payload = { franchise: f, ...a }
  const refs: Ref[] = a.n ? [{ type: 'mail', n: a.n }] : []
  const who = a.contactId
    ? `With contact ${a.contact ?? a.contactId}: Autotask emails them that it was created.`
    : 'No contact: internal, nobody is emailed.'
  return post(agent, 'ticket_create', `New ${franchiseLabel(f)} ticket for ${a.company}: ${a.title}`, payload,
    a.why?.trim() ? `${a.why.trim()}\n\n${who}` : who, refs, hop)
}

/** A feature agent's action, for Brendon's approval: nothing runs until he approves it. */
export function proposeFeature(agent: Agent, a: { action: string; args?: Record<string, unknown>; title: string; note: string; refs?: Ref[] }, hop: number): Proposal {
  const def = agent.kind === 'feature' ? featureAgent(agent.id) : null
  if (!def) throw new AgentError(403, 'only a feature agent proposes feature actions')
  const action = def.actions?.[a.action]
  if (!action) throw new AgentError(400, `no action ${a.action}; the actions are ${Object.keys(def.actions ?? {}).join(', ') || 'none'}`)
  const args = a.args ?? {}
  try {
    action.check?.(args)
  } catch (e) {
    throw new AgentError(400, (e as Error).message.slice(0, 300) || 'the action refused these args')
  }
  const title = a.title.trim().slice(0, 250)
  const note = a.note.trim()
  if (!title || !note) throw new AgentError(400, 'a proposal needs a title and a note')
  if (/[—]/.test(note)) throw new AgentError(400, 'the note has an em dash; rewrite it with commas, parentheses or colons')
  return post(agent, 'feature', title, { feature: def.feature, action: a.action, args }, note.slice(0, 2000), a.refs ?? [], hop)
}

// ------------------------------------------------------------ decide ----

function tellAgent(p: Proposal, status: string, result: string, reason?: string, wakeIt = false): void {
  const agent = getAgent(p.agentId)
  if (!agent) return
  addEvent(agent.id, 'proposal', { id: p.id, title: p.title, status, result, ...(reason ? { reason } : {}) })
  if (wakeIt) wake(agent.id, 30_000, `proposal ${status}`)
}

const MAIL_KINDS: ProposalKind[] = ['mail_reply', 'mail_new']

export async function approveProposal(id: number, opts: { how?: 'send' | 'draft'; body?: string; cc?: string[] } = {}): Promise<Proposal> {
  const cur = getProposal(id)
  if (!cur) throw new AgentError(404, `no proposal ${id}`)
  const payload = { ...cur.payload }
  if (MAIL_KINDS.includes(cur.kind)) {
    // He approves only the draft he read: a card with no body stored is never approvable, and the card sends back
    // the text it showed. An approval without it came from an app that never showed the draft (before v0.3.228 a
    // new mail card was a bare title), so it is refused.
    if (isMissing(draftBody(cur.payload.body))) throw new AgentError(409, `draft missing: proposal ${id} has no mail body, so there is nothing to approve`)
    if (typeof opts.body !== 'string') throw new AgentError(409, 'this app did not show the draft; update Valkyrie and approve it from the card')
    const edited = draftBody(opts.body)
    if (isMissing(edited)) throw new AgentError(400, 'the draft is empty: nothing to send')
    payload.body = edited
    if (Array.isArray(opts.cc)) {
      for (const x of opts.cc) if (!EMAIL_RE.test(x)) throw new AgentError(400, `not an address: ${x}`)
      payload.cc = opts.cc
    }
    payload.how = opts.how === 'draft' ? 'draft' : 'send'
  }
  const p = moveProposal(id, ['pending', 'failed'], 'running', { payload, result: '' })
  if (!p) throw new AgentError(409, `proposal ${id} is ${cur.status}`)

  if (p.kind === 'mail_reply') {
    const draft = payload.how === 'draft'
    if (p.payload.messageId) {
      queueAction(p.id, 'thor', draft ? 'mail_draft' : 'mail_send', {
        mailbox: p.payload.mailbox, graphId: p.payload.messageId, fromSupport: p.payload.fromSupport === true, followUp: p.payload.followUp === true,
        franchise: p.payload.franchise, body: p.payload.body, replyAll: p.payload.replyAll === true, cc: p.payload.cc ?? [],
        to: p.payload.toList ?? [], subject: p.payload.subject,
      })
    } else {
      const mail = getMail(Number(p.payload.n))
      if (!mail) return fail(p, 'the mail is gone from Valkyrie (older than 30 days)')
      queueAction(p.id, 'thor', draft ? 'mail_draft' : 'mail_send', {
        mailbox: mail.address, graphId: mail.graphId, fromSupport: Boolean(workConf().mailboxRoutes[mail.mailbox]),
        franchise: p.payload.franchise, body: p.payload.body, replyAll: p.payload.replyAll, cc: p.payload.cc,
        to: mail.fromAddress, subject: mail.subject, internetSubject: mail.subject,
      })
    }
    kickThor()
    return getProposal(id)!
  }

  if (p.kind === 'mail_new') {
    queueAction(p.id, 'thor', payload.how === 'draft' ? 'mail_new_draft' : 'mail_new', {
      franchise: p.payload.franchise, from: p.payload.from, to: p.payload.to, cc: p.payload.cc ?? [], subject: p.payload.subject, body: p.payload.body,
    })
    kickThor()
    return getProposal(id)!
  }

  if (p.kind === 'feature') return applyFeature(p)
  if (p.kind === 'ticket_complete') return applyComplete(p)

  const f = p.payload.franchise as Franchise
  try {
    let result = ''
    let ref: Ref | null = null
    const tid = Number(p.payload.ticketId)
    if (p.kind === 'ticket_note') {
      await addInternalNote(f, tid, String(p.payload.title), String(p.payload.text))
      markSelfTouch(f, tid)
      result = `Internal note added to ${p.payload.number || tid}`
    } else if (p.kind === 'ticket_update') {
      // proposals from before 2026-11-23 carry the fields flat, not under patch
      const patch = (p.payload.patch && typeof p.payload.patch === 'object' ? p.payload.patch : patchOf(p.payload)) as TicketPatch
      const r = await updateTicket(f, tid, patch)
      markSelfTouch(f, tid)
      const t = r.ticket
      result = r.changes.length
        ? `${t.number} updated: ${changeSummary(r.changes)}. Now ${t.company}, ${t.status}, ${t.priority}, ${t.assignee ?? 'unassigned'}`
        : `${t.number} already was that way; nothing changed`
      ref = { type: 'ticket', franchise: f, id: t.id, number: t.number, title: t.title, url: t.url }
    } else if (p.kind === 'ticket_time') {
      const entry = p.payload.entry as TimeEntryInput
      await addTimeEntry(f, tid, entry)
      markSelfTouch(f, tid)
      result = `Logged ${entry.hours} h on ${p.payload.number || tid}`
    } else if (p.kind === 'ticket_create') {
      const t = await createTicket(f, {
        companyId: Number(p.payload.companyId), title: String(p.payload.title), description: String(p.payload.description),
        priority: p.payload.priority as string | undefined, queue: p.payload.queue as string | undefined,
        contactId: typeof p.payload.contactId === 'number' ? p.payload.contactId : null,
      })
      result = `Created ${t.number} for ${t.company}`
      ref = { type: 'ticket', franchise: f, id: t.id, number: t.number, title: t.title, url: t.url }
    }
    const done = moveProposal(id, ['running'], 'done', { result })!
    systemPost(p.channelId, result, ref ? [ref] : [])
    tellAgent(done, 'done', result)
    return done
  } catch (e) {
    return fail(p, errorText(e, id))
  }
}

function errorText(e: unknown, id: number): string {
  if (e instanceof PsaError || e instanceof AgentError) return e.message
  console.error('[agents] proposal', id, (e as Error).message)
  return 'internal error'
}

/**
 * Note, time, Complete, in that order. Each step that worked is kept in the payload, so "Try again"
 * after a failure picks up where it stopped and never writes the note or the time twice.
 */
async function applyComplete(p: Proposal): Promise<Proposal> {
  const f = p.payload.franchise as Franchise
  const tid = Number(p.payload.ticketId)
  const number = String(p.payload.number || tid)
  const done = new Set(Array.isArray(p.payload.done) ? p.payload.done as string[] : [])
  const said: string[] = []
  const entry = p.payload.entry as TimeEntryInput | undefined
  try {
    if (!done.has('note')) {
      await addInternalNote(f, tid, String(p.payload.noteTitle || 'Resolution'), String(p.payload.note))
      done.add('note'); said.push('note added')
    }
    if (entry && !done.has('time')) {
      await addTimeEntry(f, tid, entry)
      done.add('time'); said.push(`${entry.hours} h logged`)
    }
    const r = await updateTicket(f, tid, { status: 'Complete', resolution: String(p.payload.resolution || p.payload.note) })
    done.add('complete')
    markSelfTouch(f, tid)
    const result = `${r.ticket.number} is ${r.ticket.status}${said.length ? ` (${said.join(', ')})` : ''}`
    const ok = moveProposal(p.id, ['running'], 'done', { result, payload: { ...p.payload, done: [...done] } })!
    systemPost(p.channelId, result, [{ type: 'ticket', franchise: f, id: r.ticket.id, number: r.ticket.number, title: r.ticket.title, url: r.ticket.url }])
    tellAgent(ok, 'done', result)
    return ok
  } catch (e) {
    if (done.size) markSelfTouch(f, tid)
    const msg = `${said.length ? `${number}: ${said.join(', ')}; then ` : ''}${errorText(e, p.id)}`
    return fail(p, msg, { ...p.payload, done: [...done] })
  }
}

async function applyFeature(p: Proposal): Promise<Proposal> {
  const def = featureAgent(p.agentId)
  const action = def?.actions?.[String(p.payload.action ?? '')]
  if (!action) return fail(p, 'that action is not in this build any more')
  let result: string
  try {
    const args = p.payload.args && typeof p.payload.args === 'object' ? p.payload.args as Record<string, unknown> : {}
    result = String(await action.apply(args)).trim().slice(0, 600) || 'Done'
  } catch (e) {
    // a feature's errors are written for Brendon; anything else still gets one plain line
    return fail(p, (e as Error).message.slice(0, 300) || 'the action failed')
  }
  const done = moveProposal(p.id, ['running'], 'done', { result })!
  systemPost(p.channelId, result)
  tellAgent(done, 'done', result)
  return done
}

function fail(p: Proposal, msg: string, payload?: Record<string, unknown>): Proposal {
  const failed = moveProposal(p.id, ['running'], 'failed', { result: msg, ...(payload ? { payload } : {}) })!
  systemPost(p.channelId, `Could not do proposal #${p.id}: ${msg}`)
  tellAgent(failed, 'failed', msg, undefined, true)
  return failed
}

export function declineProposal(id: number, reason?: string): Proposal {
  const why = (reason ?? '').trim().slice(0, 600)
  const p = moveProposal(id, ['pending', 'failed'], 'declined', { result: why })
  if (!p) throw new AgentError(409, `proposal ${id} is not waiting`)
  if (why) addMessage({ channelId: p.channelId, author: 'brendon', text: `Declined #${p.id}: ${why}` })
  tellAgent(p, 'declined', '', why || undefined, Boolean(why))
  return p
}

/**
 * Decline all: the oldest `count` pending proposals of one agent, or of every enabled agent, declined at once with
 * nothing sent or applied. `count` is the number Brendon confirmed, so a proposal that arrives after the confirm
 * stays waiting. Each agent gets ONE note in its next run (not one event per card) and is not woken for it.
 */
export function declineAllProposals(opts: { agentId?: string; count: number; reason?: string }): Proposal[] {
  const why = (opts.reason ?? '').trim().slice(0, 600)
  const n = Math.floor(Number(opts.count))
  if (!Number.isFinite(n) || n < 1) throw new AgentError(400, 'say how many proposals to decline (the count you confirmed)')
  if (opts.agentId && !getAgent(opts.agentId)) throw new AgentError(404, 'no such agent')
  const list = pendingProposals(opts.agentId).slice(0, n)
  const done: Proposal[] = []
  for (const p of list) {
    const d = moveProposal(p.id, ['pending'], 'declined', { result: why || 'Declined with Decline all' })
    if (d) done.push(d)
  }
  const byAgent = new Map<string, Proposal[]>()
  for (const p of done) byAgent.set(p.agentId, [...(byAgent.get(p.agentId) ?? []), p])
  for (const [agentId, ps] of byAgent) {
    addEvent(agentId, 'proposals_declined', {
      count: ps.length, ids: ps.map((p) => p.id).slice(0, 200), reason: why || undefined,
      note: 'Brendon cleared these with Decline all: nothing was sent or applied. Do not propose them again unless something new happens on the ticket or the mail.',
    })
  }
  return done
}

// ------------------------------------------------------- thor results ----

export function actionResult(actionId: number, ok: boolean, result: string): void {
  const a = finishAction(actionId, ok, result)
  if (!a) throw new AgentError(409, `action ${actionId} is not claimed`)
  const p = getProposal(a.proposalId)
  if (!p) return
  if (!ok) {
    fail(p, result || 'thor reported a failure')
    return
  }
  const draft = a.kind === 'mail_draft' || a.kind === 'mail_new_draft'
  const who = Array.isArray(p.payload.to) ? (p.payload.to as string[]).join(', ') : String(p.payload.toName || p.payload.to)
  const what = p.kind === 'mail_new' ? 'new mail' : p.payload.followUp ? 'follow-up' : 'reply'
  const text = draft
    ? `Saved to Outlook drafts: ${what} to ${who}`
    : `Sent to ${who}${result ? ` (${result})` : ''}`
  const done = moveProposal(p.id, ['running'], 'done', { result: text })
  if (!done) return
  systemPost(p.channelId, text)
  const n = Number(p.payload.n)
  if (n && !draft) {
    try { setMailState(n, p.agentId, 'handled', `replied ${etLabel(new Date().toISOString())}`) } catch { /* pruned */ }
  }
  if (!draft && p.kind === 'mail_new' && typeof p.payload.ticketId === 'number') {
    try { markSelfTouch(p.payload.franchise as Franchise, p.payload.ticketId) } catch { /* not tracked */ }
  }
  tellAgent(done, 'done', text)
}
