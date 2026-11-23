import { getMail, type Proposal } from './agentsStore.js'
import { franchiseConf, workConf } from './workConfig.js'

// The mail a proposal sends, exactly as it goes out, for the card Brendon reads before he
// approves (2026-11-23: "i need to see the draft before i approve emails every single time").
// The API sends it with every mail proposal; the app shows it in full above Send, and a card
// without a body offers no Send at all.
//
// Every approved mail leaves thor through clientmail.ps1 (thor's work bridge calls its reply,
// MIME reply and new-mail functions), whatever the franchise. What that file adds lives in odin's
// work-agents.json "mailOut" (lib/workConfig.ts), since names and addresses never live in this
// repository: the address it sends from and its signature. The closing rule is copied here. Change
// them together with clientmail.ps1.

/** The closing clientmail.ps1 adds when the body's last line is not one already. */
export const CLOSING = 'Thank you,'
/** clientmail.ps1's sign-off list: a last line that already signs off gets no "Thank you," (PowerShell -match: any case). */
export const CLOSINGS_RE = '^(thank you|thanks|thanks so much|thanks again|many thanks|thank you so much|'
  + 'best|best regards|regards|kind regards|warm regards|cheers|talk soon|'
  + 'appreciate it|much appreciated|sincerely|all the best|brendon)\\s*[,.!]?$'

/** The address a support-box reply, a follow-up and a new mail go out from, or '' when work-agents.json does not say. */
export const sendFrom = () => workConf().mailOut.from

export const MAIL_KINDS: ReadonlySet<string> = new Set(['mail_reply', 'mail_new'])

export type MailDraft = {
  from: string
  to: string[]
  cc: string[]
  /** set when the exact Cc is not known here (a reply-all whose thread Valkyrie no longer holds) */
  ccNote?: string
  subject: string
  body: string
  /** "Thank you,", added under the body unless its last line matches closingRe */
  closing: string
  closingRe: string
  /** the signature block as the reader sees it; '' when work-agents.json has none ("mailOut") */
  signature: string
  /** no body stored: nothing to read, so nothing to approve */
  missing: boolean
}

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v))
const bare = (x: string) => x.trim().replace(/^.*<([^>]+)>\s*$/, '$1').trim()

/** Addresses from a list or a "a, b; c" string, each once (any case), less the ones in `drop`. */
function addrs(v: unknown, drop: string[] = []): string[] {
  const raw = Array.isArray(v) ? v.map(str) : str(v).split(/[,;]/)
  const out: string[] = []
  const seen = new Set(drop.map((x) => x.toLowerCase()))
  for (const r of raw) {
    const a = bare(r)
    if (!a || seen.has(a.toLowerCase())) continue
    seen.add(a.toLowerCase())
    out.push(a)
  }
  return out
}

/** "RE: <subject>", the way Graph's reply and the bridge's follow-up name it. */
const reSubject = (s: string) => `RE: ${s.replace(/^\s*(re|aw|sv):\s*/i, '')}`

/** The body a draft holds, trimmed the way draftText stores it; under 10 characters is no draft. */
export const draftBody = (v: unknown) => str(v).replace(/\r\n/g, '\n').trim()
export const isMissing = (body: string) => body.length < 10

/** The mail this proposal sends, or null when it sends none. */
export function mailDraft(p: Pick<Proposal, 'kind' | 'payload'>): MailDraft | null {
  if (!MAIL_KINDS.has(p.kind)) return null
  const pl = p.payload
  const body = draftBody(pl.body)
  const out = workConf().mailOut
  const base = { body, closing: CLOSING, closingRe: CLOSINGS_RE, signature: out.signature, missing: isMissing(body) }
  // the bridge sends new mail, support-box replies and follow-ups from this one address
  const own = out.from || franchiseConf(str(pl.franchise))?.mailbox || ''

  if (p.kind === 'mail_new') {
    return { ...base, from: str(pl.from) || own, to: addrs(pl.to), cc: addrs(pl.cc), subject: str(pl.subject) }
  }

  // a reply: to a mail Valkyrie holds (n), or to a message read on thor (messageId)
  const held = !pl.messageId && pl.n != null ? getMail(Number(pl.n)) : null
  const fromSupport = pl.messageId ? pl.fromSupport === true : Boolean(held && workConf().mailboxRoutes[held.mailbox])
  const followUp = pl.followUp === true
  const mailbox = str(pl.mailbox) || held?.address || own
  // a reply in the mailbox it came to goes out from that mailbox; a support-box reply and a follow-up from his own
  const from = fromSupport || followUp ? own : mailbox
  const subject = reSubject(str(pl.subject) || held?.subject || '')

  if (followUp) return { ...base, from, to: addrs(pl.toList ?? pl.to), cc: addrs(pl.cc), subject }

  const sender = bare(str(pl.to) || held?.fromAddress || '')
  const name = str(pl.toName) || held?.fromName || ''
  const senderLine = name && sender ? `${name} <${sender}>` : sender
  if (pl.replyAll !== true) return { ...base, from, to: senderLine ? [senderLine] : [], cc: addrs(pl.cc), subject }

  // reply-all: the thread's own people (the message's To and Cc), stored on the card or held with the mail
  const threadTo = pl.threadTo ?? held?.toList
  const threadCc = pl.threadCc ?? held?.ccList
  if (threadTo === undefined && threadCc === undefined) {
    return { ...base, from, to: senderLine ? [senderLine] : [], cc: [], ccNote: 'everyone else on the thread', subject }
  }
  if (fromSupport) {
    // the bridge: the sender in To, everyone else on their message in Cc, less Brendon
    return { ...base, from, to: senderLine ? [senderLine] : [], cc: addrs([...addrs(threadTo), ...addrs(threadCc)], [own, sender]), subject }
  }
  // Graph replyAll from the mailbox: the sender and the message's To in To, its Cc in Cc, less the mailbox itself
  const rest = addrs(threadTo, [mailbox, sender])
  return { ...base, from, to: [...(senderLine ? [senderLine] : []), ...rest], cc: addrs(threadCc, [mailbox, sender, ...rest]), subject }
}

/** A proposal as the app gets it: the stored card, plus the mail it sends in full when it sends one. */
export function proposalView(p: Proposal) {
  const draft = mailDraft(p)
  return {
    id: p.id, kind: p.kind, title: p.title, payload: p.payload, status: p.status, result: p.result || null, decidedAt: p.decidedAt,
    ...(draft ? { draft } : {}),
  }
}
