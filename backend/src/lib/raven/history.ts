import { AgentError, findMessages, getMessage, listMessages, messagesBetween, type Message } from '../agentsStore.js'
import { liveTag } from './notices.js'
import { RAVEN_CHANNEL, RAVEN_ID } from './types.js'
import { et } from './tools/util.js'

// Raven's own thread, all of it: search every message in #raven and read any of
// them in full. A run's prompt carries only the last 40 messages, each cut at
// 700 characters; these reach the rest. Used by thread_search and thread_read
// (tools/thread.ts).

export const SEARCH_MAX = 50
const MAX_TERMS = 8
const READ_MAX_CHARS = 60_000
const READ_MAX_MSGS = 50

/** Who wrote a message, as the thread names them: Brendon, Raven, a relay's label, an agent. */
export function threadAuthor(m: Message): string {
  if (m.author === 'brendon') return 'Brendon'
  const relay = m.meta.relay
  if (relay) {
    const what = relay.kind === 'agent' ? `@${relay.from}` : relay.kind === 'session' ? 'session' : relay.kind
    return `${relay.label} (${what})`
  }
  if (m.author === RAVEN_ID) return 'Raven'
  if (m.author === 'system') return 'Valkyrie'
  return `@${m.author}`
}

/** `"faction ships" player` to ['faction ships', 'player']: a quoted phrase stays whole, other words split, lowercase. */
export function queryTerms(q: string): string[] {
  const out: string[] = []
  const re = /"([^"]+)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(q)) !== null) {
    const t = m[1] !== undefined
      ? m[1].trim().replace(/\s+/g, ' ').toLowerCase()
      : m[2].toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    if (t && !out.includes(t)) out.push(t)
  }
  // "or", "in", "a" match nearly every message; keep them only when nothing longer was given
  const long = out.filter((t) => t.length >= 3)
  return (long.length ? long : out).slice(0, MAX_TERMS)
}

const flat = (s: string) => s.replace(/\s+/g, ' ').trim()

/** About 320 characters of text around the earliest term it has; '' when it has none. */
function around(text: string, terms: string[]): string {
  const low = text.toLowerCase()
  let at = -1
  let len = 0
  for (const t of terms) {
    const i = low.indexOf(t)
    if (i >= 0 && (at < 0 || i < at)) { at = i; len = t.length }
  }
  if (at < 0) return ''
  const start = Math.max(0, at - 120)
  const end = Math.min(text.length, at + len + 200)
  return `${start > 0 ? '…' : ''}${flat(text.slice(start, end))}${end < text.length ? '…' : ''}`
}

/** Where the terms are when the text itself does not have them: a file's name, then a session line kept under it. */
function snippetOf(m: Message, terms: string[]): string {
  const inText = around(m.text, terms)
  if (inText) return inText
  for (const f of m.meta.files ?? []) if (terms.some((t) => f.name.toLowerCase().includes(t))) return `[file: ${f.name}]`
  for (const s of m.meta.sessions ?? []) {
    for (const l of s.lines) {
      const hit = around(l.text, terms)
      if (hit) return `[session ${s.title || s.label}] ${hit}`
    }
  }
  return flat(m.text).slice(0, 200)
}

export type ThreadHit = { id: number; createdAt: string; at: string; author: string; snippet: string; length: number; replyTo?: number; words?: number }

/**
 * Every message in the thread with all the words of q, newest first. When none has all of them (a word misspelled,
 * a quote remembered a little wrong), the messages with any of them, the most words first: mode 'any'.
 */
export function searchThread(q: string, opts: { limit?: number; before?: number; from?: 'brendon' | 'raven'; sessions?: boolean } = {}): {
  terms: string[]; mode: 'all' | 'any'; total: number; hits: ThreadHit[]; more?: boolean
} {
  const terms = queryTerms(q)
  if (!terms.length) throw new AgentError(400, 'search for at least one word')
  const limit = Math.min(SEARCH_MAX, Math.max(1, opts.limit ?? 20))
  const base = { author: opts.from, before: opts.before, sessions: opts.sessions }
  let mode: 'all' | 'any' = 'all'
  let found = findMessages(RAVEN_CHANNEL, terms, base)
  if (!found.length && terms.length > 1) {
    mode = 'any'
    found = findMessages(RAVEN_CHANNEL, terms, { ...base, any: true })
  }
  const hits = found.slice(0, limit).flatMap(({ id, score }) => {
    const m = getMessage(id)
    if (!m) return []
    const hit: ThreadHit = { id, createdAt: m.createdAt, at: et(m.createdAt), author: threadAuthor(m), snippet: snippetOf(m, terms), length: m.text.length }
    if (m.meta.replyTo) hit.replyTo = m.meta.replyTo
    if (mode === 'any') hit.words = score
    return [hit]
  })
  return { terms, mode, total: found.length, hits, more: found.length > limit || undefined }
}

const num = (n: number) => n.toLocaleString('en-US')

/** A message's text from start: all of it, or READ_MAX_CHARS of a long one with where the next part starts. */
function textPart(m: Message, start: number): string {
  const len = m.text.length
  if (!len) return '(no text)'
  if (start >= len) return `[the text ends at character ${num(len)}]`
  if (!start && len <= READ_MAX_CHARS) return m.text
  const end = Math.min(len, start + READ_MAX_CHARS)
  const note = end < len ? `thread_read id ${m.id} start ${end} reads on` : 'the end'
  return `${m.text.slice(start, end)}\n[characters ${num(start + 1)} to ${num(end)} of ${num(len)}: ${note}]`
}

/** One message in full (a long one in parts from start), as thread_read shows it. */
function render(m: Message, sessions: boolean, start = 0): string {
  const head = [`#${m.id}`, et(m.createdAt), threadAuthor(m)]
  if (m.meta.replyTo) head.push(`reply to #${m.meta.replyTo}`)
  if (m.meta.error) head.push('failed')
  const out = [head.join(' · ') + liveTag(m, et)]
  if (m.meta.files?.length) out.push(`[files: ${m.meta.files.map((f) => `${f.name} (id ${f.id})`).join(', ')}]`)
  out.push(textPart(m, start))
  if (sessions) {
    for (const s of m.meta.sessions ?? []) {
      out.push(`[what session ${s.title || s.label} wrote, read in this run${s.more ? `, ${s.more} older lines left out` : ''}]`)
      for (const l of s.lines) out.push(`  ${et(l.at)}: ${l.text}`)
    }
  }
  return out.join('\n')
}

/**
 * Thread messages in full, oldest first: one (id), one with its neighbors (around, context each side), or a range
 * (from, to). Stops before 60 KB and says where to go on; a message longer than that reads in parts (id with start).
 */
export function readThread(opts: { id?: number; start?: number; around?: number; context?: number; from?: number; to?: number; sessions?: boolean }): string {
  let msgs: Message[]
  if (opts.id !== undefined) {
    const m = getMessage(opts.id)
    msgs = m && m.channelId === RAVEN_CHANNEL ? [m] : []
    if (!msgs.length) throw new AgentError(404, `no message #${opts.id} in the thread`)
  } else if (opts.around !== undefined) {
    const c = Math.min(20, Math.max(0, opts.context ?? 3))
    const before = listMessages(RAVEN_CHANNEL, { before: opts.around + 1, limit: c + 1 })
    if (!before.some((m) => m.id === opts.around)) throw new AgentError(404, `no message #${opts.around} in the thread`)
    msgs = [...before, ...(c ? listMessages(RAVEN_CHANNEL, { after: opts.around, limit: c }) : [])]
  } else if (opts.from !== undefined || opts.to !== undefined) {
    const from = opts.from ?? 1
    const to = opts.to ?? Number.MAX_SAFE_INTEGER
    if (to < from) throw new AgentError(400, 'to comes before from')
    msgs = messagesBetween(RAVEN_CHANNEL, from, to, READ_MAX_MSGS + 1)
    if (!msgs.length) return `No thread message from #${from}${opts.to !== undefined ? ` to #${to}` : ' on'}.`
  } else {
    throw new AgentError(400, 'give id, around, or from and to')
  }
  const out: string[] = []
  let size = 0
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    if (i === READ_MAX_MSGS) { out.push(`[more: call again with from ${m.id}]`); break }
    const block = render(m, opts.sessions === true, opts.id !== undefined ? Math.max(0, opts.start ?? 0) : 0)
    if (out.length && size + block.length > READ_MAX_CHARS) { out.push(`[stopped at 60 KB: call again with from ${m.id}]`); break }
    out.push(block)
    size += block.length
  }
  return out.join('\n\n')
}
