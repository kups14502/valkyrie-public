import { AgentError } from './agentsStore.js'

// Brendon's work mailbox, read live on thor. The Graph certificate never
// leaves thor, so odin asks thor's project-files service (the same one that
// serves project folders): POST /mail/search and /mail/read run the mail
// bridge there (search and read only; it answers in a second or two), and
// POST /mail/kick starts thor's work bridge at once, so an approved send goes
// out now instead of at the next minute. Sends never go through here: they
// stay queued actions that thor claims (lib/agentActions.ts), where the send
// helper's duplicate guard runs.

const URL_BASE = () => process.env.PROJECT_FILES_URL || 'http://100.118.7.57:8767'
const TOKEN = () => process.env.PROJECT_FILES_TOKEN || ''

async function call<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
  if (!TOKEN()) throw new AgentError(503, 'the thor mail service is not configured on odin (PROJECT_FILES_TOKEN)')
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const r = await fetch(`${URL_BASE()}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    })
    const text = await r.text()
    let j: Record<string, unknown> = {}
    try { j = text ? JSON.parse(text) as Record<string, unknown> : {} } catch { /* not json */ }
    if (!r.ok) throw new AgentError(r.status === 404 ? 404 : r.status === 400 ? 400 : 502, String(j.error || `thor answered ${r.status}`).slice(0, 400))
    return j as T
  } catch (e) {
    if (e instanceof AgentError) throw e
    throw new AgentError(502, (e as Error).name === 'AbortError' ? 'thor took too long to read the mailbox' : 'thor is not answering (it can be off or asleep)')
  } finally {
    clearTimeout(timer)
  }
}

export type MailHit = { messageId: string; received: string; from: string; to: string; subject: string; isRead: boolean; hasAttachments: boolean; preview: string }
export type MailMessage = {
  messageId: string; received: string; from: string; fromName: string; to: string[]; cc: string[]; subject: string
  conversationId: string; body: string; attachments: { name: string; size: number; inline: boolean }[]
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v : String(v ?? '').split(','))
  .map((x) => String(x).trim()).filter(Boolean)

/** Messages in one mailbox (every folder, or only inbox or sent), newest first. query is Outlook search text; from narrows to a sender. */
export async function mailboxSearch(o: { mailbox: string; query?: string; from?: string; folder?: 'all' | 'inbox' | 'sent'; top?: number }): Promise<MailHit[]> {
  const r = await call<{ messages?: Record<string, unknown>[] }>('/mail/search', {
    mailbox: o.mailbox, query: o.query, from: o.from, folder: o.folder ?? 'all', top: Math.min(25, Math.max(1, o.top ?? 10)),
  }, 45_000)
  return (r.messages ?? []).map((m) => ({
    messageId: String(m.message_id ?? ''), received: String(m.received ?? ''), from: String(m.from ?? ''), to: String(m.to ?? ''),
    subject: String(m.subject ?? ''), isRead: m.is_read === true, hasAttachments: m.has_attachments === true, preview: String(m.preview ?? ''),
  })).filter((m) => m.messageId)
}

/** One message with its text (cut at 20,000 characters) and its recipients. */
export async function mailboxRead(mailbox: string, messageId: string): Promise<MailMessage> {
  const m = await call<Record<string, unknown>>('/mail/read', { mailbox, message_id: messageId }, 45_000)
  return {
    messageId: String(m.message_id ?? messageId), received: String(m.received ?? ''),
    from: String(m.from ?? ''), fromName: String(m.from_name ?? ''), to: list(m.to), cc: list(m.cc), subject: String(m.subject ?? ''),
    conversationId: String(m.conversation_id ?? ''), body: String(m.body ?? ''),
    attachments: (Array.isArray(m.attachments) ? m.attachments as Record<string, unknown>[] : []).map((a) => ({
      name: String(a.name ?? ''), size: Number(a.size_bytes ?? 0), inline: a.inline === true,
    })),
  }
}

/** Asks thor to run its work bridge now. Best effort: the bridge's own minute schedule is the fallback. */
export function kickThor(): void {
  if (!TOKEN()) return
  void call('/mail/kick', {}, 10_000).catch(() => { /* the next scheduled run picks it up */ })
}
