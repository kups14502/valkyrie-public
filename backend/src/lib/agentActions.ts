import {
  addEvent, addMessage, addProposal, AgentError, finishAction, getAgent, getMail, getProposal, markSelfTouch, moveProposal, pendingProposals,
  queueAction, setMailState, setProposalMessage, trackedTicket, type Agent, type Proposal, type ProposalKind, type Ref,
} from './agentsStore.js'
import { addInternalNote, createTicket, franchiseLabel, PsaError, ticketUrl, updateTicket, type Franchise, type TicketPatch } from './psa.js'
import { agentPost, etLabel, systemPost, wake } from './agents.js'
import { franchiseConf, workConf } from './workConfig.js'
import { featureAgent } from './featureAgents.js'

// Proposals: what an agent wants done in the outside world, waiting on
// Brendon. Each one is approved by itself (approval of one email is never
// approval of the next). On approval Valkyrie does it, not the agent:
//   ticket_note / ticket_update / ticket_create  Autotask, from odin (lib/psa.ts)
//   mail_reply                                   queued for thor, which replies
//                                                with clientmail.ps1 (the
//                                                certificate never leaves thor,
//                                                and its send ledger refuses a
//                                                duplicate within 24 hours)
//   feature                                      the feature agent's own action
//                                                (lib/featureAgents.ts), in the API

/** The address a reply copies by default: the franchise's support queue. */
const supportCc = (f: Franchise): string[] => {
  const cc = franchiseConf(f)?.supportCc
  return cc ? [cc] : []
}

const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[a-z]{2,}$/i

// ------------------------------------------------------------- create ----

function post(agent: Agent, kind: ProposalKind, title: string, payload: Record<string, unknown>, text: string, refs: Ref[], hop: number): Proposal {
  const p = addProposal({ agentId: agent.id, channelId: agent.channelId, kind, title, payload })
  const msg = agentPost(agent, agent.channelId, text, { refs, notify: true, hop, proposalId: p.id })
  setProposalMessage(p.id, msg.id)
  return getProposal(p.id)!
}

export function proposeMailReply(agent: Agent, a: { n: number; body: string; replyAll?: boolean; cc?: string[]; note?: string }, hop: number): Proposal {
  const mail = getMail(a.n)
  if (!mail) throw new AgentError(404, `no mail #${a.n}`)
  const franchise = (mail.franchise ?? agent.franchise) as Franchise | null
  if (!franchise) throw new AgentError(400, 'this mail has no franchise yet; only the triage agents reply to work mail')
  if (agent.franchise !== franchise) throw new AgentError(403, `mail #${a.n} belongs to ${franchiseLabel(franchise)}; hand it to that triage agent`)
  const body = a.body.trim()
  if (body.length < 10) throw new AgentError(400, 'the draft is empty')
  if (/[—]/.test(body)) throw new AgentError(400, 'the draft has an em dash; rewrite it with commas, parentheses or colons')
  const cc = (a.cc ?? supportCc(franchise)).map((x) => x.trim()).filter(Boolean)
  for (const x of cc) if (!EMAIL_RE.test(x)) throw new AgentError(400, `not an address: ${x}`)
  const payload = {
    n: mail.n, franchise, body, replyAll: Boolean(a.replyAll), cc: a.replyAll ? [] : cc, note: (a.note ?? '').slice(0, 600),
    to: mail.fromAddress, toName: mail.fromName, subject: mail.subject,
  }
  const title = `Reply to ${mail.fromName || mail.fromAddress}: ${mail.subject || '(no subject)'}`
  const text = a.note?.trim() || `Draft reply to ${mail.fromName || mail.fromAddress} for your approval.`
  return post(agent, 'mail_reply', title, payload, text, [{ type: 'mail', n: mail.n, subject: mail.subject, from: mail.fromName || mail.fromAddress, url: mail.webLink ?? undefined }], hop)
}

/** The ticket a proposal is about, named by its number (agents often pass only the id). */
function ticketRef(f: Franchise, id: number, number?: string): { number: string; ref: Ref } {
  const tr = trackedTicket(f, id)
  const num = number?.trim() || tr?.number || String(id)
  return { number: num, ref: { type: 'ticket', franchise: f, id, number: num, title: tr?.title, url: ticketUrl(f, id) } }
}

export function proposeTicketNote(agent: Agent, a: { ticketId: number; number?: string; title: string; text: string; why?: string }, hop: number): Proposal {
  const f = agent.franchise
  if (!f || agent.kind !== 'triage') throw new AgentError(403, 'only the triage agents propose ticket notes')
  const t = ticketRef(f, a.ticketId, a.number)
  const payload = { franchise: f, ticketId: a.ticketId, number: t.number, title: a.title.slice(0, 250), text: a.text.slice(0, 8000) }
  return post(agent, 'ticket_note', `Internal note on ${t.number}: ${a.title}`, payload,
    a.why?.trim() || 'An internal note for your approval.', [t.ref], hop)
}

export function proposeTicketUpdate(agent: Agent, a: { ticketId: number; number?: string } & TicketPatch & { why: string }, hop: number): Proposal {
  const f = agent.franchise
  if (!f || agent.kind !== 'triage') throw new AgentError(403, 'only the triage agents propose ticket changes')
  const change: string[] = []
  if (a.status) change.push(`status to ${a.status}`)
  if (a.priority) change.push(`priority to ${a.priority}`)
  if (a.assignToBrendon) change.push('assign to Brendon')
  if (a.due) change.push(`due ${a.due}`)
  if (!change.length) throw new AgentError(400, 'nothing to change')
  const t = ticketRef(f, a.ticketId, a.number)
  const payload = { franchise: f, ticketId: a.ticketId, number: t.number, status: a.status, priority: a.priority, assignToBrendon: a.assignToBrendon, due: a.due }
  const closes = /^complete$/i.test(a.status ?? '')
  return post(agent, 'ticket_update', `${t.number}: ${change.join(', ')}`, payload,
    `${a.why.trim()}${closes ? '\n\nCompleting it emails the contact the resolution.' : ''}`, [t.ref], hop)
}

export function proposeTicketCreate(agent: Agent, a: { companyId: number; company: string; title: string; description: string; priority?: string; queue?: string; contactId?: number; contact?: string; n?: number; why?: string }, hop: number): Proposal {
  const f = agent.franchise
  if (!f || agent.kind !== 'triage') throw new AgentError(403, 'only the triage agents propose new tickets')
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
  if (/[\u2014]/.test(note)) throw new AgentError(400, 'the note has an em dash; rewrite it with commas, parentheses or colons')
  return post(agent, 'feature', title, { feature: def.feature, action: a.action, args }, note.slice(0, 2000), a.refs ?? [], hop)
}

// ------------------------------------------------------------ decide ----

function tellAgent(p: Proposal, status: string, result: string, reason?: string, wakeIt = false): void {
  const agent = getAgent(p.agentId)
  if (!agent) return
  addEvent(agent.id, 'proposal', { id: p.id, title: p.title, status, result, ...(reason ? { reason } : {}) })
  if (wakeIt) wake(agent.id, 30_000, `proposal ${status}`)
}

export async function approveProposal(id: number, opts: { how?: 'send' | 'draft'; body?: string; cc?: string[] } = {}): Promise<Proposal> {
  const cur = getProposal(id)
  if (!cur) throw new AgentError(404, `no proposal ${id}`)
  const payload = { ...cur.payload }
  if (cur.kind === 'mail_reply') {
    if (typeof opts.body === 'string' && opts.body.trim()) payload.body = opts.body.trim()
    if (Array.isArray(opts.cc)) {
      for (const x of opts.cc) if (!EMAIL_RE.test(x)) throw new AgentError(400, `not an address: ${x}`)
      payload.cc = opts.cc
    }
    payload.how = opts.how === 'draft' ? 'draft' : 'send'
  }
  const p = moveProposal(id, ['pending', 'failed'], 'running', { payload, result: '' })
  if (!p) throw new AgentError(409, `proposal ${id} is ${cur.status}`)

  if (p.kind === 'mail_reply') {
    const mail = getMail(Number(p.payload.n))
    if (!mail) return fail(p, 'the mail is gone from Valkyrie (older than 30 days)')
    queueAction(p.id, 'thor', payload.how === 'draft' ? 'mail_draft' : 'mail_send', {
      mailbox: mail.address, graphId: mail.graphId, fromSupport: Boolean(workConf().mailboxRoutes[mail.mailbox]),
      franchise: p.payload.franchise, body: p.payload.body, replyAll: p.payload.replyAll, cc: p.payload.cc,
      to: mail.fromAddress, subject: mail.subject, internetSubject: mail.subject,
    })
    return getProposal(id)!
  }

  if (p.kind === 'feature') return applyFeature(p)

  const f = p.payload.franchise as Franchise
  try {
    let result = ''
    let ref: Ref | null = null
    if (p.kind === 'ticket_note') {
      const tid = Number(p.payload.ticketId)
      await addInternalNote(f, tid, String(p.payload.title), String(p.payload.text))
      markSelfTouch(f, tid)
      result = `Internal note added to ${p.payload.number || tid}`
    } else if (p.kind === 'ticket_update') {
      const tid = Number(p.payload.ticketId)
      const t = await updateTicket(f, tid, {
        status: p.payload.status as string | undefined, priority: p.payload.priority as string | undefined,
        assignToBrendon: p.payload.assignToBrendon === true, due: p.payload.due as string | undefined,
      })
      markSelfTouch(f, tid)
      result = `${t.number} is now ${t.status}, ${t.priority}, ${t.assignee ?? 'unassigned'}`
      ref = { type: 'ticket', franchise: f, id: t.id, number: t.number, title: t.title, url: t.url }
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
    const msg = e instanceof PsaError || e instanceof AgentError ? e.message : 'internal error'
    if (!(e instanceof PsaError || e instanceof AgentError)) console.error('[agents] proposal', id, (e as Error).message)
    return fail(p, msg)
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

function fail(p: Proposal, msg: string): Proposal {
  const failed = moveProposal(p.id, ['running'], 'failed', { result: msg })!
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
  const draft = a.kind === 'mail_draft'
  const text = draft
    ? `Saved to Outlook drafts: reply to ${p.payload.toName || p.payload.to}`
    : `Sent to ${p.payload.toName || p.payload.to}${result ? ` (${result})` : ''}`
  const done = moveProposal(p.id, ['running'], 'done', { result: text })
  if (!done) return
  systemPost(p.channelId, text)
  const n = Number(p.payload.n)
  if (n && !draft) {
    try { setMailState(n, p.agentId, 'handled', `replied ${etLabel(new Date().toISOString())}`) } catch { /* pruned */ }
  }
  tellAgent(done, 'done', text)
}
