import {
  addEvent, addMail, addTeams, closeTracked, getKv, openTrackedIds, routeMail, senderByEmail, sendersByDomain, setKv,
  setTeamsAgent, trackedByNumber, upsertTracked, replaceSenders, type MailItem, type TicketChange, AgentError,
} from './agentsStore.js'
import { allContacts, franchiseLabel, getTicket, openTickets, psaConfigured, PsaError, type Franchise } from './psa.js'
import { franchiseKeys, triageAgentId, workConf } from './workConfig.js'
import { wake } from './agents.js'

// What the triage agents watch:
//   * tickets: each franchise's Autotask polled every 5 minutes into the
//     tracker (lib/agentsStore.ts tickets); new, moved and closed tickets
//     become events
//   * mail: thor's Work-Bridge.ps1 posts each new work message with its text;
//     it is routed to one franchise by sender and ticket number
//   * Teams: Brendon's chats, from the same thor job, go to the franchise
//     work-agents.json names for them
//
// Routing is deterministic first (Autotask contacts, the ticket number in the
// subject, the franchise's own domains, the shared mailbox it arrived in) and
// falls back to the default franchise's triage, which reads the mail and hands
// it to another franchise when it is theirs.

const POLL_MS = Number(process.env.AGENTS_TICKET_POLL_MS || 5 * 60_000)
const SENDERS_MS = 24 * 3_600_000
/** Mail older than this when it first arrives (the first sync's backlog) is filed, not processed. */
const FRESH_MS = 12 * 3_600_000

const GENERIC = new Set(['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'me.com', 'aol.com', 'live.com', 'msn.com', 'comcast.net', 'verizon.net', 'optonline.net'])
/** Senders the agents never need by default: the ticket poller already sees every Autotask change. */
const SKIP_DOMAINS = ['autotask.net']
const TICKET_RE = /\bT\d{8}\.\d{4}\b/i

function ownDomain(domain: string): Franchise | null {
  return workConf().franchises.find((f) => f.ownDomains.includes(domain))?.key ?? null
}

// ------------------------------------------------------------ tickets ----

const pollState = new Map<Franchise, { at: string | null; error: string | null; open: number }>()

export function feedStatus() {
  return {
    tickets: Object.fromEntries(franchiseKeys().map((f) => [f, pollState.get(f) ?? { at: null, error: null, open: 0 }])),
    mail: { lastAt: getKv('mail-last-at'), lastCount: Number(getKv('mail-last-count') ?? 0) },
    teams: { lastAt: getKv('teams-last-at') },
  }
}

/** Activity worth waking triage for: Brendon's tickets, nobody's, or a client reply. */
function worthWaking(c: TicketChange): boolean {
  if (c.self && c.kind === 'activity') return false
  if (c.kind !== 'activity') return true
  const t = c.ticket
  if (t.mine || !t.assignee || t.needsBrendon) return true
  return c.changes.some((x) => /Received Client Reply|assignee/i.test(x))
}

export async function pollTickets(f: Franchise): Promise<{ open: number; events: number }> {
  const agentId = triageAgentId(f)
  if (!agentId) throw new AgentError(404, `no triage agent for ${f}`)
  const first = getKv(`tracker-seeded-${f}`) !== '1'
  const open = await openTickets(f)
  const seen = new Set<number>()
  const changes: TicketChange[] = []
  for (const t of open) {
    seen.add(t.id)
    const c = upsertTracked(t, false)
    if (c) changes.push(c)
  }
  // gone from the open list: completed, or moved into Monitoring Alert
  for (const id of openTrackedIds(f).filter((x) => !seen.has(x)).slice(0, 40)) {
    try {
      const t = await getTicket(f, id)
      const c = upsertTracked(t, true)
      if (c) changes.push(c)
    } catch (e) {
      if (e instanceof PsaError && e.status === 404) closeTracked(f, id)
      else throw e
    }
  }
  pollState.set(f, { at: new Date().toISOString(), error: null, open: open.length })
  if (first) {
    setKv(`tracker-seeded-${f}`, '1')
    addEvent(agentId, 'tracker_seeded', { open: open.length })
    wake(agentId, 60_000, 'first look at the tickets')
    return { open: open.length, events: 1 }
  }
  let events = 0
  for (const c of changes) {
    if (!worthWaking(c)) continue
    const t = c.ticket
    addEvent(agentId, `ticket_${c.kind}`, {
      id: t.id, number: t.number, title: t.title, company: t.company, status: t.status, priority: t.priority,
      assignee: t.assignee, changes: c.changes,
    })
    events++
  }
  if (events) wake(agentId, 90_000, `${events} ticket change${events === 1 ? '' : 's'}`)
  return { open: open.length, events }
}

export async function refreshSenders(f: Franchise): Promise<number> {
  const rows = (await allContacts(f)).filter((c) => c.email && c.active)
  replaceSenders(f, rows.map((c) => ({ email: c.email, companyId: c.companyId, company: c.company, name: c.name })))
  setKv(`senders-at-${f}`, new Date().toISOString())
  return rows.length
}

// --------------------------------------------------------------- mail ----

type Route = { franchise: Franchise | null; match: string; skip?: string; shared?: boolean }

export function routeFor(m: Pick<MailItem, 'mailbox' | 'fromAddress' | 'subject' | 'focused'>): Route {
  const conf = workConf()
  const from = m.fromAddress.toLowerCase()
  const domain = from.split('@')[1] ?? ''
  if (conf.self.includes(from)) return { franchise: null, match: '', skip: 'from Brendon himself' }
  if ([...SKIP_DOMAINS, ...conf.skipDomains].includes(domain)) return { franchise: null, match: '', skip: `from ${domain}, which the agents skip` }
  const byBox = conf.mailboxRoutes[m.mailbox]
  if (byBox) return { franchise: byBox, match: `arrived in ${franchiseLabel(byBox)}'s shared mailbox`, shared: true }
  const num = TICKET_RE.exec(m.subject)?.[0]
  const byTicket = num ? [...new Set(trackedByNumber(num).map((t) => t.franchise))] : []
  if (num && byTicket.length === 1) return { franchise: byTicket[0], match: `ticket ${num.toUpperCase()} is ${franchiseLabel(byTicket[0])}'s` }
  const contacts = senderByEmail(from)
  const fr = [...new Set(contacts.map((c) => c.franchise))]
  if (fr.length === 1) return { franchise: fr[0], match: `Autotask contact ${contacts[0].name} at ${contacts[0].company} (${franchiseLabel(fr[0])})` }
  const own = ownDomain(domain)
  if (own) return { franchise: own, match: `${franchiseLabel(own)} colleague` }
  const fallback = conf.defaultFranchise
  if (!GENERIC.has(domain) && domain) {
    const doms = sendersByDomain(domain)
    const df = [...new Set(doms.map((d) => d.franchise))]
    if (df.length === 1) return { franchise: df[0], match: `same domain as ${doms[0].company} contacts (${franchiseLabel(df[0])})` }
    if (df.length > 1) return { franchise: fallback, match: `domain known in more than one franchise (${doms.map((d) => `${d.company} ${franchiseLabel(d.franchise)}`).join(', ')})` }
  }
  if (!m.focused) return { franchise: null, match: '', skip: 'Other folder, sender unknown to every Autotask' }
  return { franchise: fallback, match: 'sender unknown to every Autotask', skip: fallback ? undefined : 'no default franchise' }
}

type FeedMail = {
  id?: unknown; conversationId?: unknown; subject?: unknown; fromName?: unknown; fromAddress?: unknown; to?: unknown; cc?: unknown
  receivedAt?: unknown; body?: unknown; webLink?: unknown; importance?: unknown; focused?: unknown; attachments?: unknown
}

const str = (v: unknown, max: number) => String(v ?? '').slice(0, max)
const list = (v: unknown, max: number) => (Array.isArray(v) ? v.map((x) => String(x)).join(', ') : str(v, max)).slice(0, max)

export function ingestMail(input: { mailbox?: unknown; address?: unknown; messages?: unknown }): { added: number; routed: number } {
  const mailbox = str(input.mailbox, 32)
  const address = str(input.address, 200)
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(mailbox) || !address.includes('@')) throw new AgentError(400, 'mailbox and address are required')
  const msgs = Array.isArray(input.messages) ? (input.messages as FeedMail[]).slice(0, 100) : []
  let added = 0, routed = 0
  const woke = new Set<string>()
  for (const m of msgs) {
    const graphId = str(m.id, 400)
    const received = str(m.receivedAt, 40)
    if (!graphId || Number.isNaN(Date.parse(received))) continue
    const item = addMail({
      mailbox, address, graphId, conversationId: str(m.conversationId, 400), subject: str(m.subject, 400),
      fromName: str(m.fromName, 200), fromAddress: str(m.fromAddress, 200).toLowerCase(), toList: list(m.to, 2000), ccList: list(m.cc, 2000),
      receivedAt: new Date(received).toISOString(), body: str(m.body, 16_000), webLink: typeof m.webLink === 'string' && m.webLink.startsWith('https://') ? m.webLink.slice(0, 1200) : null,
      importance: str(m.importance, 10) || 'normal', focused: m.focused !== false, attachments: list(m.attachments, 600),
    })
    if (!item) continue
    added++
    const r = routeFor(item)
    if (Date.now() - Date.parse(item.receivedAt) > FRESH_MS) {
      routeMail(item.n, r.franchise, null, 'handled', 'arrived before the agents started watching')
      continue
    }
    if (!r.franchise) {
      routeMail(item.n, null, null, 'ignored', r.skip ?? 'not routed')
      continue
    }
    const agentId = triageAgentId(r.franchise)
    if (!agentId) { routeMail(item.n, r.franchise, null, 'ignored', 'no triage agent for its franchise'); continue }
    routeMail(item.n, r.franchise, agentId)
    addEvent(agentId, 'mail', {
      n: item.n, from: item.fromName, fromAddress: item.fromAddress, subject: item.subject, receivedAt: item.receivedAt,
      match: r.match, mailbox, shared: r.shared === true, address,
    })
    woke.add(agentId)
    routed++
  }
  for (const id of woke) wake(id, 60_000, 'new mail')
  setKv('mail-last-at', new Date().toISOString())
  setKv('mail-last-count', String(added))
  return { added, routed }
}

// -------------------------------------------------------------- teams ----

type FeedTeams = { id?: unknown; chatId?: unknown; chatTopic?: unknown; fromName?: unknown; text?: unknown; createdAt?: unknown; webUrl?: unknown }

export function ingestTeams(input: { messages?: unknown }): { added: number } {
  const msgs = Array.isArray(input.messages) ? (input.messages as FeedTeams[]).slice(0, 100) : []
  let added = 0
  const teamsF = workConf().teamsFranchise
  const agentId = teamsF ? triageAgentId(teamsF) : null
  for (const m of msgs) {
    const id = str(m.id, 200), chatId = str(m.chatId, 300), created = str(m.createdAt, 40)
    if (!id || !chatId || Number.isNaN(Date.parse(created))) continue
    const t = addTeams({
      id: `${chatId}:${id}`, chatId, chatTopic: str(m.chatTopic, 200), fromName: str(m.fromName, 120), text: str(m.text, 4000),
      createdAt: new Date(created).toISOString(), webUrl: typeof m.webUrl === 'string' && m.webUrl.startsWith('https://') ? m.webUrl.slice(0, 1200) : null,
    })
    if (!t) continue
    added++
    if (Date.now() - Date.parse(t.createdAt) > FRESH_MS || !agentId) continue
    setTeamsAgent(t.id, agentId)
    addEvent(agentId, 'teams', { chat: t.chatTopic || 'a chat', from: t.fromName, text: t.text.slice(0, 1500), createdAt: t.createdAt })
  }
  if (added && agentId) wake(agentId, 90_000, 'Teams messages')
  setKv('teams-last-at', new Date().toISOString())
  return { added }
}

// -------------------------------------------------------------- start ----

let started = false

export function startWorkFeeds(): void {
  if (started) return
  started = true
  const tick = async () => {
    for (const f of franchiseKeys()) {
      if (!psaConfigured(f)) continue
      try {
        const last = Date.parse(getKv(`senders-at-${f}`) ?? '') || 0
        if (Date.now() - last > SENDERS_MS) await refreshSenders(f)
      } catch (e) {
        console.error(`[feeds] ${f} senders:`, (e as Error).message)
      }
      try {
        await pollTickets(f)
      } catch (e) {
        const msg = (e as Error).message.slice(0, 300)
        pollState.set(f, { ...(pollState.get(f) ?? { at: null, open: 0 }), error: msg })
        console.error(`[feeds] ${f} tickets:`, msg)
      }
    }
  }
  const first = setTimeout(() => { void tick() }, 20_000)
  first.unref?.()
  const t = setInterval(() => { void tick() }, POLL_MS)
  t.unref?.()
}
