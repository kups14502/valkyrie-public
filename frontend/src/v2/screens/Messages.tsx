import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Button, Press, toast } from '../kit/ui'
import { ago, useTick } from '../kit/data'
import { useIntent, type ScreenProps } from '../kit/shell'
import { RavenComposer, RavenFiles } from '../kit/raven'
import { RAVEN_KEY, addToThread, refreshRavenUnread, useRaven, useRavenDraft } from '../kit/ravenStore'
import { Markdown } from '../../components/Markdown'
import { apiErrorText } from '../../lib/api'
import { TERM_NAME_RE, v2TermPath } from '../../lib/term'
import {
  RAVEN_OLDER, approveProposal, declineProposal, etTime, fetchRavenOlder, markRavenRead, modelLabel, ravenBusy, ravenStatusText,
  sendRaven, stopRaven, type Proposal, type RavenMsg, type RavenPage, type Ref,
} from '../../lib/ravenApi'
import './messages.css'

// Messages (/m/messages): one conversation, Brendon and Raven (backend
// lib/raven). Raven answers here, and what the agents, his sessions, the
// features and Valkyrie itself say comes in as relays, labeled by their source;
// the agents' proposals sit inline as cards he decides. Newest at the bottom,
// older pages load on scroll-up, everything updates through the Messages
// long-poll. A wide screen keeps a narrow "Connected" column on the right (main
// terminals, watched sessions, agents, feeds); a narrow one opens it from
// the header. Old links (?c=<channel>) land here; ?compose=1 focuses the box.

const NY_DAY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' })
const NY_KEY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })

/** "Today", "Yesterday", or "Tue, Nov 17" in New York */
function dayLabel(t: number, now: number): string {
  const k = NY_KEY.format(t)
  if (k === NY_KEY.format(now)) return 'Today'
  if (k === NY_KEY.format(now - 86_400_000)) return 'Yesterday'
  return NY_DAY.format(t)
}

/** The root's width: the UI zoom hides from media queries, so measure. */
function useWide(ref: RefObject<HTMLDivElement | null>, at: number): boolean {
  const [wide, setWide] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => { if (el.clientWidth > 0) setWide(el.clientWidth >= at) }
    const ro = new ResizeObserver(read)
    ro.observe(el)
    read()
    return () => ro.disconnect()
  }, [ref, at])
  return wide
}

/** The app is in front (an app brought back with the thread open reads it then). */
function usePageShown(): boolean {
  const [shown, setShown] = useState(() => !document.hidden)
  useEffect(() => {
    const on = () => setShown(!document.hidden)
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])
  return shown
}

const SOURCE_WORD: Record<string, string> = { siri: 'Siri', hotkey: 'hotkey', api: 'API' }

export default function Messages({ active }: ScreenProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const wide = useWide(rootRef, 960)
  const [params, setParams] = useSearchParams()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const q = useRaven(active)
  const page = q.data
  const [showConn, setShowConn] = useState(false)
  const draft = useRavenDraft()
  const ta = useRef<HTMLTextAreaElement>(null)

  // older pages, fetched on scroll-up; the live read always carries the newest 60
  const [older, setOlder] = useState<RavenMsg[]>([])
  const [noMore, setNoMore] = useState(false)
  const loadingOlder = useRef(false)
  const messages = useMemo(() => {
    const live = page?.messages ?? []
    const first = live[0]?.id ?? Infinity
    return [...older.filter((m) => m.id < first), ...live]
  }, [older, page])
  // once older pages are in, a line that slides out of the newest 60 (new ones came) joins them, so no gap opens
  const [kept, setKept] = useState<RavenPage | undefined>(undefined)
  if (page !== kept) {
    setKept(page)
    if (older.length && kept) {
      const was = kept.messages
      // the newest copy of each line wins (a proposal decided since)
      setOlder((cur) => [...new Map([...cur, ...was].map((m) => [m.id, m])).values()].sort((a, b) => a.id - b.id))
    }
  }
  // an agent's line with no relay label still shows the agent's name
  const names = useMemo(() => new Map((page?.agents ?? []).map((a) => [a.id, a.name])), [page])

  // ?compose=1 focuses the box; ?c=<channel> (an old push) is dropped: there is one conversation
  const compose = params.get('compose') === '1'
  useEffect(() => {
    if (!active || (!compose && !params.has('c'))) return
    if (compose) ta.current?.focus({ preventScroll: true })
    const p = new URLSearchParams(params)
    p.delete('compose')
    p.delete('c')
    setParams(p, { replace: true })
  }, [active, compose, params, setParams])

  // Ctrl+Shift+Space and the palette's "Message Raven" here: the box below, not the quick sheet
  useIntent('raven:compose', () => ta.current?.focus(), active)

  // ---- the list: stick to the newest, load older at the top ----
  const listRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const lastId = messages.length ? messages[messages.length - 1].id : 0
  const firstId = messages[0]?.id ?? 0
  const busy = ravenBusy(page)

  useLayoutEffect(() => {
    const el = listRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [lastId, busy, active])

  // the list got shorter (Connected opened, chips or a longer line in the box): the newest line stays in view
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const ro = new ResizeObserver(() => { if (stick.current) el.scrollTop = el.scrollHeight })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // an older page went in above: hold what was on screen where it was
  const anchor = useRef<{ h: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const el = listRef.current
    const a = anchor.current
    if (!el || !a) return
    anchor.current = null
    el.scrollTop = a.top + (el.scrollHeight - a.h)
  }, [firstId])

  const loadOlder = async () => {
    const el = listRef.current
    if (!el || loadingOlder.current || noMore || !firstId) return
    loadingOlder.current = true
    try {
      const got = await fetchRavenOlder(firstId)
      if (got.length < RAVEN_OLDER) setNoMore(true)
      if (got.length) {
        anchor.current = { h: el.scrollHeight, top: el.scrollTop }
        setOlder((cur) => {
          const have = new Set(cur.map((m) => m.id))
          return [...got.filter((m) => !have.has(m.id)), ...cur].sort((a, b) => a.id - b.id)
        })
      }
    } catch (e) {
      toast(apiErrorText(e, 'Could not read older messages'), { ms: 4000 })
    } finally {
      loadingOlder.current = false
    }
  }

  const onScroll = () => {
    const el = listRef.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    stick.current = bottom
    if (bottom !== atBottom) setAtBottom(bottom)
    if (el.scrollTop < 160) void loadOlder()
  }

  // read what is on screen: the newest line in view, the page in front
  const unread = page?.unread ?? 0
  const shown = usePageShown()
  useEffect(() => {
    if (!active || !atBottom || !unread || !lastId || !shown) return
    void markRavenRead(lastId).then(() => {
      refreshRavenUnread(qc)
      void qc.invalidateQueries({ queryKey: RAVEN_KEY })
    }, () => { /* the count stays until the next read */ })
  }, [active, atBottom, unread, lastId, shown, qc])

  // ---- writes ----
  const send = useMutation({
    mutationFn: () => sendRaven({ text: draft.text.trim(), files: draft.ids.length ? draft.ids : undefined, source: 'app' }),
    onSuccess: (m) => {
      draft.clear()
      stick.current = true
      addToThread(qc, { messages: [m] })
      void qc.invalidateQueries({ queryKey: RAVEN_KEY })
    },
    onError: (e) => toast(apiErrorText(e, 'Raven did not answer'), { ms: 4000 }),
  })
  const stop = useMutation({
    mutationFn: stopRaven,
    onSuccess: () => void qc.invalidateQueries({ queryKey: RAVEN_KEY }),
    onError: (e) => toast(apiErrorText(e, 'Raven did not stop'), { ms: 4000 }),
  })

  const status = page ? ravenStatusText(page) : ''
  const failed = q.isError && !page
  const connected = page ? <Connected page={page} messages={messages} onOpen={(to) => navigate(to)} /> : null

  return (
    <div
      className="rv"
      ref={rootRef}
      data-wide={wide || undefined}
      onDragOver={(e) => { if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault() }}
      onDrop={(e) => {
        // a drop on the composer attached them already (it bubbles here)
        if (e.defaultPrevented) return
        const files = Array.from(e.dataTransfer.files)
        if (!files.length) return
        e.preventDefault()
        draft.add(files)
      }}
    >
      <section className="rv-conv" aria-label="Raven">
        <header className="rv-head">
          <h2>Raven</h2>
          {/* a narrow header keeps the first word while Raven works; the live line at the end of the thread has the model and effort */}
          <span className="rv-status" data-state={page?.status} data-busy={busy || undefined} title={status || undefined}>{failed ? 'not answering' : busy && !wide ? status.split(' · ')[0] : status}</span>
          {busy && <Button kind="link" className="rv-stop" disabled={stop.isPending} onPress={() => stop.mutate()}>Stop</Button>}
          {!wide && page && (
            <Press className="rv-conn-toggle" data-on={showConn || undefined} aria-expanded={showConn} onPress={() => setShowConn((v) => !v)}>Connected</Press>
          )}
        </header>
        {!wide && showConn && connected && <div className="rv-conn rv-conn-drop">{connected}</div>}
        <div className="rv-msgs" ref={listRef} onScroll={onScroll}>
          {failed && <p className="rv-quiet">Raven is not answering: {apiErrorText(q.error, 'no reply from Valkyrie')}</p>}
          {!page && !failed && <p className="rv-quiet">Reading Raven</p>}
          {page && !messages.length && <p className="rv-quiet">Nothing yet. Write Raven anything: a question, a task, a file, a session to start.</p>}
          {page && noMore && messages.length > 0 && <p className="rv-quiet rv-top">The start of the conversation.</p>}
          <Thread messages={messages} names={names} />
          {busy && (
            <div className="rv-working" aria-live="polite">
              <span className="rv-pulse" aria-hidden />
              <span>{status}</span>
            </div>
          )}
        </div>
        <RavenComposer draft={draft} sending={send.isPending} onSend={() => send.mutate()} placeholder="Message Raven" taRef={ta} />
      </section>
      {wide && connected && <aside className="rv-conn rv-side" aria-label="Connected">{connected}</aside>}
    </div>
  )
}

// ------------------------------------------------------------- the thread ---

function Thread({ messages, names }: { messages: RavenMsg[]; names: Map<string, string> }) {
  const now = useTick(60_000)
  return (
    <>
      {messages.map((m, i) => {
        const prev = messages[i - 1]
        const t = Date.parse(m.createdAt)
        const newDay = !prev || NY_KEY.format(Date.parse(prev.createdAt)) !== NY_KEY.format(t)
        const grouped = !newDay && !!prev && who(prev) === who(m) && t - Date.parse(prev.createdAt) < 10 * 60_000 && !m.proposal
        return (
          <div key={m.id} className="rv-item">
            {newDay && <div className="rv-day"><span>{dayLabel(t, now)}</span></div>}
            <Row m={m} grouped={grouped} names={names} />
          </div>
        )
      })}
    </>
  )
}

/** Who a row is from, for grouping: the author, and a relay's source. */
const who = (m: RavenMsg) => `${m.author}|${m.meta.relay?.kind ?? ''}|${m.meta.relay?.from ?? ''}`

function kindOf(m: RavenMsg): 'me' | 'raven' | 'relay' | 'system' {
  if (m.meta.relay) return 'relay'
  if (m.author === 'brendon') return 'me'
  if (m.author === 'raven') return 'raven'
  if (m.author === 'system') return 'system'
  return 'relay'
}

function Row({ m, grouped, names }: { m: RavenMsg; grouped: boolean; names: Map<string, string> }) {
  const navigate = useNavigate()
  const kind = kindOf(m)
  const relay = m.meta.relay
  const pane = relay?.kind === 'session' && TERM_NAME_RE.test(relay.from) ? relay.from : null
  const termPath = pane ? v2TermPath(pane) : null
  const label = kind === 'me' ? 'You' : kind === 'raven' ? 'Raven' : kind === 'system' ? 'Valkyrie' : relay?.label || names.get(m.author) || m.author
  const via = kind === 'me' && m.meta.source ? SOURCE_WORD[m.meta.source] : undefined
  const meta = kind === 'raven' && !m.meta.error
    ? [modelLabel(m.meta.model, m.meta.tier), m.meta.effort, etTime(m.createdAt)].filter(Boolean).join(' · ')
    : null
  // a session relay's ref link to its pane is the Open link already
  const refs = termPath ? m.refs.filter((r) => !(r.type === 'link' && r.url === termPath)) : m.refs
  return (
    <article className="rv-msg" data-kind={kind} data-relay={relay?.kind} data-grouped={grouped || undefined} data-error={m.meta.error ? '' : undefined}>
      {!grouped && (
        <div className="rv-msg-head">
          <b>{label}</b>
          {termPath && (
            <a
              className="rv-open"
              href={termPath}
              onClick={(e) => { e.preventDefault(); navigate(termPath) }}
            >Open</a>
          )}
          {!meta && <time title={NY_DAY.format(Date.parse(m.createdAt))}>{etTime(m.createdAt)}</time>}
          {via && <span className="rv-via">via {via}</span>}
        </div>
      )}
      {m.text && <Markdown className="rv-md">{m.text}</Markdown>}
      {m.meta.files && m.meta.files.length > 0 && <RavenFiles files={m.meta.files} />}
      {refs.length > 0 && <Refs refs={refs} />}
      {m.proposal && <ProposalCard p={m.proposal} />}
      {meta && <p className="rv-meta" title={m.meta.why || undefined}>{meta}</p>}
    </article>
  )
}

function Refs({ refs }: { refs: Ref[] }) {
  const navigate = useNavigate()
  const items: ReactNode[] = refs.map((r, i) => {
    if (r.type === 'ticket') return <a key={i} className="rv-ref" href={r.url} target="_blank" rel="noopener noreferrer">{r.number}{r.title ? ` · ${r.title}` : ''}</a>
    if (r.type === 'mail') {
      const label = `Mail${r.from ? ` from ${r.from}` : ''}${r.subject ? `: ${r.subject}` : ''}`
      return r.url ? <a key={i} className="rv-ref" href={r.url} target="_blank" rel="noopener noreferrer">{label}</a> : <span key={i} className="rv-ref">{label}</span>
    }
    if (r.type === 'link') {
      const label = r.label || r.url.replace(/^https:\/\//, '').slice(0, 60)
      // an app path moves inside the app; never opens a window of its own
      if (/^\/m\//.test(r.url)) return <a key={i} className="rv-ref" href={r.url} onClick={(e) => { e.preventDefault(); navigate(r.url) }}>{label}</a>
      return /^https?:\/\//.test(r.url) ? <a key={i} className="rv-ref" href={r.url} target="_blank" rel="noopener noreferrer">{label}</a> : null
    }
    return null
  })
  return <div className="rv-refs">{items}</div>
}

// --------------------------------------------------------------- proposals ---

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v))

/** An agent's proposal inline: a mail draft he can edit, then Send, Save to drafts or Decline; anything else Approve or Decline. */
function ProposalCard({ p }: { p: Proposal }) {
  const qc = useQueryClient()
  const pl = (p.payload && typeof p.payload === 'object' ? p.payload : {}) as Record<string, unknown>
  const mail = p.kind === 'mail_reply'
  const [body, setBody] = useState(str(pl.body))
  const [declining, setDeclining] = useState(false)
  const [reason, setReason] = useState('')
  const pending = p.status === 'pending' || p.status === 'failed'
  const refresh = () => qc.invalidateQueries({ queryKey: RAVEN_KEY })
  const approve = useMutation({
    mutationFn: (how: 'send' | 'draft') => approveProposal(p.id, mail ? { how, body } : {}),
    onSuccess: (_r, how) => { toast(mail ? (how === 'draft' ? 'Saving to Outlook drafts' : 'Sending from thor') : 'Done'); void refresh() },
    onError: (e) => toast(apiErrorText(e, 'Valkyrie did not answer'), { ms: 5000 }),
  })
  const decline = useMutation({
    mutationFn: () => declineProposal(p.id, reason),
    onSuccess: () => { setDeclining(false); void refresh() },
    onError: (e) => toast(apiErrorText(e, 'Valkyrie did not answer'), { ms: 5000 }),
  })
  const cc = Array.isArray(pl.cc) ? (pl.cc as string[]) : []

  return (
    <div className="rv-prop" data-status={p.status}>
      <div className="rv-prop-head">
        <b>{p.title}</b>
        <span className="rv-prop-state">{
          p.status === 'pending' ? 'waiting for you'
            : p.status === 'running' ? (mail ? 'with thor' : 'working')
              : p.status === 'done' ? 'done' : p.status === 'declined' ? 'declined' : 'failed'
        }</span>
      </div>
      {mail && (
        <dl className="rv-prop-meta">
          <dt>To</dt><dd>{str(pl.toName) ? `${str(pl.toName)} <${str(pl.to)}>` : str(pl.to)}</dd>
          {pl.replyAll ? <><dt>Cc</dt><dd>everyone on the thread</dd></> : cc.length > 0 && <><dt>Cc</dt><dd>{cc.join(', ')}</dd></>}
          <dt>Subject</dt><dd>RE: {str(pl.subject).replace(/^re:\s*/i, '')}</dd>
        </dl>
      )}
      {p.kind === 'ticket_note' && <pre className="rv-prop-body">{str(pl.title)}{'\n\n'}{str(pl.text)}</pre>}
      {p.kind === 'ticket_create' && <pre className="rv-prop-body">{str(pl.company)}: {str(pl.title)}{'\n\n'}{str(pl.description)}</pre>}
      {mail && (pending
        ? <textarea className="rv-prop-edit" value={body} onChange={(e) => setBody(e.target.value)} rows={Math.min(16, Math.max(5, body.split('\n').length + 1))} aria-label="The draft" />
        : <pre className="rv-prop-body">{str(pl.body)}</pre>)}
      {mail && pending && <p className="rv-prop-hint">"Thank you," and your signature are added when it goes out.</p>}
      {p.result && p.status !== 'pending' && <p className="rv-prop-result">{p.result}</p>}
      {pending && !declining && (
        <div className="rv-prop-acts">
          {mail ? (
            <>
              <Button kind="line" lit disabled={approve.isPending} onPress={() => approve.mutate('send')}>{p.status === 'failed' ? 'Try sending again' : 'Send'}</Button>
              <Button kind="link" disabled={approve.isPending} onPress={() => approve.mutate('draft')}>Save to Outlook drafts</Button>
            </>
          ) : (
            <Button kind="line" lit disabled={approve.isPending} onPress={() => approve.mutate('send')}>{p.status === 'failed' ? 'Try again' : 'Approve'}</Button>
          )}
          <Button kind="link" onPress={() => setDeclining(true)}>Decline</Button>
        </div>
      )}
      {declining && (
        <form className="rv-prop-decline" onSubmit={(e) => { e.preventDefault(); decline.mutate() }}>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why (optional, the agent learns from it)" autoFocus />
          <Button kind="link" type="button" disabled={decline.isPending} onPress={() => decline.mutate()}>Decline</Button>
          <Button kind="link" type="button" onPress={() => setDeclining(false)}>Keep</Button>
        </form>
      )}
    </div>
  )
}

// -------------------------------------------------------------- connected ---

const MAIN_WORD: Record<string, string> = { working: 'working', idle: 'idle', closed: 'not open', dead: 'ended' }
const AGENT_WORD: Record<string, string> = { idle: 'idle', queued: 'about to start', working: 'working', resting: 'resting', error: 'last run failed' }

/** The feeds that wrote into the thread (a feature's process, an odin script), each with its latest line. */
function feedLines(messages: RavenMsg[]): { label: string; text: string; at: string }[] {
  const seen = new Map<string, { label: string; text: string; at: string }>()
  for (let i = messages.length - 1; i >= 0; i--) {
    const r = messages[i].meta.relay
    if (r?.kind !== 'feature') continue
    const key = r.from || r.label
    if (seen.has(key)) continue
    seen.set(key, { label: r.label || r.from, text: messages[i].text.split('\n')[0].replace(/[*_`#>]/g, '').trim(), at: messages[i].createdAt })
  }
  return [...seen.values()]
}

/** What Raven reaches: his main terminals, the sessions it watches, the agents, the feeds. */
function Connected({ page, messages, onOpen }: { page: RavenPage; messages: RavenMsg[]; onOpen: (to: string) => void }) {
  const now = useTick(60_000)
  const feeds = feedLines(messages)
  const open = (pane: string) => (
    <a className="rv-open" href={v2TermPath(pane)} onClick={(e) => { e.preventDefault(); onOpen(v2TermPath(pane)) }}>Open</a>
  )
  const empty = !page.mains.length && !page.watching.length && !page.agents.length && !feeds.length
  return (
    <>
      {empty && <p className="rv-quiet">Nothing connected yet.</p>}
      {page.mains.length > 0 && (
        <div className="rv-group">
          <h3>Main terminals</h3>
          {page.mains.map((t) => (
            <div key={t.target} className="rv-crow" data-state={t.state}>
              <span className="rv-dot" data-state={t.state === 'working' ? 'working' : t.state === 'idle' ? 'idle' : 'off'} aria-hidden />
              <span className="rv-crow-name">{t.label}</span>
              <span className="rv-crow-note">{MAIN_WORD[t.state] ?? t.state}</span>
              {t.pane && t.state !== 'dead' && open(t.pane)}
            </div>
          ))}
        </div>
      )}
      {page.watching.length > 0 && (
        <div className="rv-group">
          <h3>Watching</h3>
          {page.watching.map((w) => (
            <div key={w.pane || w.sessionId} className="rv-crow">
              <span className="rv-dot" data-state="watch" aria-hidden />
              <span className="rv-crow-name">{w.label}</span>
              <span className="rv-crow-note" title={etTime(w.since)}>{ago(Date.parse(w.since), now)}</span>
              {w.pane && open(w.pane)}
            </div>
          ))}
        </div>
      )}
      {page.agents.length > 0 && (
        <div className="rv-group">
          <h3>Agents{page.paused ? <span className="rv-warn"> · paused</span> : null}</h3>
          {page.agents.map((a) => (
            <div key={a.id} className="rv-crow" data-state={a.status}>
              <span className="rv-dot" data-state={page.paused ? 'off' : a.status} aria-hidden />
              <span className="rv-crow-name">{a.name}</span>
              <span className="rv-crow-note">{AGENT_WORD[a.status] ?? a.status}</span>
              {a.pending > 0 && <span className="rv-n" title={`${a.pending} waiting for you`}>{a.pending}</span>}
            </div>
          ))}
        </div>
      )}
      {feeds.length > 0 && (
        <div className="rv-group">
          <h3>Feeds</h3>
          {feeds.map((f) => (
            <div key={f.label} className="rv-crow">
              <span className="rv-dot" data-state="idle" aria-hidden />
              <span className="rv-crow-name">{f.label}</span>
              <span className="rv-crow-note" title={etTime(f.at)}>{ago(Date.parse(f.at), now)}</span>
              {f.text && <span className="rv-crow-line">{f.text}</span>}
            </div>
          ))}
        </div>
      )}
    </>
  )
}
