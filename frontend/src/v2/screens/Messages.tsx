import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { Button, Press, toast } from '../kit/ui'
import { useTick } from '../kit/data'
import { Markdown } from '../../components/Markdown'
import { apiErrorText } from '../../lib/api'
import {
  approveProposal, checkAgent, declineProposal, fetchAgent, fetchChannel, fetchOverview, fetchTickets, markRead, patchAgent,
  postMessage, setAgentsPaused, waitMsgChange,
  type Msg, type MsgAgent, type MsgChannel, type Overview, type Proposal, type Ref,
} from '../../lib/messagesApi'
import type { ScreenProps } from '../kit/shell'
import './messages.css'

// Messages (/m/messages): Brendon and his AI employees (backend lib/agents.ts).
// Left: the channels (Team, each agent's own channel, the DMs agents open
// between themselves), each with its agent's state and unread count. Right:
// one channel as a conversation, with the agent's proposals inline (a draft
// reply he can edit, then Send, Save as draft or Decline), its tracked tickets
// for the triage agents, and its switches (check now, pause, model, notebook).
// On a narrow screen the list and the conversation take turns. Everything
// updates live through one long-poll.

const NY_TIME = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })
const NY_DAY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' })
const NY_KEY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })

function when(iso: string | null, now: number): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  const d = now - t
  if (d < 60_000) return 'now'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`
  if (NY_KEY.format(t) === NY_KEY.format(now)) return NY_TIME.format(t)
  return NY_DAY.format(t)
}

const STATUS_WORD: Record<MsgAgent['status'], string> = {
  idle: 'idle', queued: 'about to start', working: 'working', resting: 'resting', error: 'last run failed',
}

const MODELS: { id: string; label: string }[] = [
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
]

/** Re-reads everything in Messages whenever the backend says something changed. */
function useLive(active: boolean, seq: number | undefined) {
  const qc = useQueryClient()
  useEffect(() => {
    if (!active || seq === undefined) return
    const ac = new AbortController()
    let since = seq
    let stop = false
    void (async () => {
      while (!stop) {
        try {
          const next = await waitMsgChange(since, ac.signal)
          if (stop) return
          if (next !== since) {
            since = next
            await qc.invalidateQueries({ queryKey: ['msg'] })
          }
        } catch {
          if (stop) return
          await new Promise((r) => setTimeout(r, 5000))
        }
      }
    })()
    return () => { stop = true; ac.abort() }
    // the loop carries its own count; it restarts only when the screen wakes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, seq === undefined])
}

/** The root's width: the UI zoom hides from media queries, so measure. */
function useWide(ref: React.RefObject<HTMLDivElement | null>): boolean {
  const [wide, setWide] = useState(true)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setWide(el.clientWidth >= 760))
    ro.observe(el)
    setWide(el.clientWidth >= 760)
    return () => ro.disconnect()
  }, [ref])
  return wide
}

export default function Messages({ active }: ScreenProps) {
  const [params, setParams] = useSearchParams()
  const picked = params.get('c')
  const rootRef = useRef<HTMLDivElement>(null)
  const wide = useWide(rootRef)
  const qc = useQueryClient()
  const ov = useQuery({ queryKey: ['msg', 'overview'], queryFn: fetchOverview, enabled: active, refetchOnWindowFocus: true })
  useLive(active, ov.data?.seq)

  const channels = useMemo(() => ov.data?.channels ?? [], [ov.data])
  const agents = useMemo(() => new Map((ov.data?.agents ?? []).map((a) => [a.id, a])), [ov.data])
  // a wide screen always shows a conversation: the one asked for, else Team
  const current = picked && channels.some((c) => c.id === picked) ? picked : wide ? channels[0]?.id ?? null : null

  const open = (id: string | null) => {
    const p = new URLSearchParams(params)
    if (id) p.set('c', id)
    else p.delete('c')
    setParams(p, { replace: wide })
  }

  const pause = useMutation({
    mutationFn: (paused: boolean) => setAgentsPaused(paused),
    onSuccess: (r) => { toast(r.paused ? 'All agents paused' : 'Agents back on'); void qc.invalidateQueries({ queryKey: ['msg'] }) },
    onError: (e) => toast(apiErrorText(e, 'Valkyrie did not answer'), { ms: 4000 }),
  })

  const status = ov.isError && !ov.data ? `Messages are not answering: ${apiErrorText(ov.error, 'no reply from Valkyrie')}` : null

  return (
    <div className="mx" ref={rootRef} data-wide={wide || undefined}>
      {(wide || !current) && (
        <aside className="mx-side" aria-label="Channels">
          {status && <p className="mx-quiet">{status}</p>}
          {!ov.data && !status && <p className="mx-quiet">Reading Messages</p>}
          {ov.data && <ChannelList data={ov.data} agents={agents} current={current} onOpen={open} />}
          {ov.data && (
            <div className="mx-side-foot">
              {ov.data.paused && <span className="mx-warn">All agents are paused</span>}
              <Button kind="link" onPress={() => pause.mutate(!ov.data!.paused)}>{ov.data.paused ? 'Turn agents back on' : 'Pause all agents'}</Button>
            </div>
          )}
        </aside>
      )}
      {current && (
        <Conversation
          key={current}
          channelId={current}
          channel={channels.find((c) => c.id === current) ?? null}
          agents={agents}
          active={active}
          onBack={wide ? undefined : () => open(null)}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------- the list ---

function ChannelList({ data, agents, current, onOpen }: { data: Overview; agents: Map<string, MsgAgent>; current: string | null; onOpen: (id: string) => void }) {
  const now = useTick(30_000)
  const groups: { label: string; items: MsgChannel[] }[] = [
    { label: '', items: data.channels.filter((c) => c.kind === 'team') },
    { label: 'Agents', items: data.channels.filter((c) => c.kind === 'home' && agents.get(c.agentIds[0])?.kind !== 'project') },
    { label: 'Projects', items: data.channels.filter((c) => c.kind === 'home' && agents.get(c.agentIds[0])?.kind === 'project') },
    { label: 'Between agents', items: data.channels.filter((c) => c.kind === 'dm') },
  ]
  return (
    <nav className="mx-list">
      {groups.filter((g) => g.items.length).map((g) => (
        <div key={g.label || 'top'} className="mx-group">
          {g.label && <h3 className="mx-group-label">{g.label}</h3>}
          {g.items.map((c) => {
            const a = c.kind === 'home' ? agents.get(c.agentIds[0]) : undefined
            const busy = a && (a.status === 'working' || a.status === 'queued')
            return (
              <Press key={c.id} className="mx-row" data-on={c.id === current || undefined} data-unread={c.unread || undefined} onPress={() => onOpen(c.id)}>
                <span className="mx-dot" data-state={a ? (a.enabled ? a.status : 'off') : 'none'} aria-hidden />
                <span className="mx-row-text">
                  <b>{c.kind === 'team' ? '# Team' : c.name}</b>
                  <span>{busy ? a!.statusNote || STATUS_WORD[a!.status] : c.last ? `${c.last.author === 'brendon' ? 'You: ' : ''}${c.last.text}` : a?.role ?? c.topic}</span>
                </span>
                <span className="mx-row-meta">
                  {c.unread > 0 && <span className="mx-n" data-hot={c.notify > 0 || undefined}>{c.unread}</span>}
                  <time>{when(c.lastMessageAt, now)}</time>
                </span>
              </Press>
            )
          })}
        </div>
      ))}
    </nav>
  )
}

// ----------------------------------------------------------- conversation ---

type View = 'chat' | 'tickets' | 'agent'

function Conversation({ channelId, channel, agents, active, onBack }: {
  channelId: string; channel: MsgChannel | null; agents: Map<string, MsgAgent>; active: boolean; onBack?: () => void
}) {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['msg', 'channel', channelId], queryFn: () => fetchChannel(channelId), enabled: active })
  const [view, setView] = useState<View>('chat')
  const agent = q.data?.agent ?? null
  const msgs = useMemo(() => q.data?.messages ?? [], [q.data])
  const listRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  // read what is on screen
  const lastId = msgs.length ? msgs[msgs.length - 1].id : 0
  useEffect(() => {
    if (!active || !lastId || view !== 'chat') return
    if ((channel?.unread ?? 0) > 0) {
      void markRead(channelId, lastId).then(() => qc.invalidateQueries({ queryKey: ['msg', 'overview'] }))
    }
  }, [active, lastId, channelId, channel?.unread, view, qc])

  // keep the newest message in view unless he scrolled up
  useLayoutEffect(() => {
    const el = listRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [msgs.length, view])

  const tabs: { id: View; label: string }[] = [{ id: 'chat', label: 'Chat' }]
  if (agent?.kind === 'triage') tabs.push({ id: 'tickets', label: q.data?.tracker ? `Tickets ${q.data.tracker.open}` : 'Tickets' })
  if (agent) tabs.push({ id: 'agent', label: 'Agent' })

  const title = channel?.kind === 'team' ? '# Team' : channel?.name ?? channelId
  const sub = agent
    ? `${agent.enabled ? STATUS_WORD[agent.status] : 'paused'}${agent.statusNote && agent.enabled ? `: ${agent.statusNote}` : ''}`
    : channel?.topic ?? ''

  return (
    <section className="mx-conv" aria-label={title}>
      <header className="mx-head">
        {onBack && <Press className="mx-back" onPress={onBack} aria-label="All channels">‹</Press>}
        <div className="mx-head-text">
          <h2>{title}</h2>
          <p data-state={agent?.enabled ? agent.status : undefined}>{sub}</p>
        </div>
        {tabs.length > 1 && (
          <nav className="mx-tabs">
            {tabs.map((t) => (
              <Press key={t.id} className="mx-tab" data-on={t.id === view || undefined} onPress={() => setView(t.id)}>{t.label}</Press>
            ))}
          </nav>
        )}
      </header>
      {view === 'chat' && (
        <>
          <div
            className="mx-msgs"
            ref={listRef}
            onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }}
          >
            {q.isError && !q.data && <p className="mx-quiet">{apiErrorText(q.error, 'Could not read this channel')}</p>}
            {q.data && !msgs.length && <p className="mx-quiet">{agent ? `Nothing yet. ${agent.name} posts here when it has something for you.` : 'Nothing yet.'}</p>}
            {msgs.map((m, i) => <MessageRow key={m.id} m={m} prev={msgs[i - 1]} agents={agents} />)}
          </div>
          <Composer channelId={channelId} channel={channel} agent={agent} />
        </>
      )}
      {view === 'tickets' && agent?.franchise && <Tickets franchise={agent.franchise} />}
      {view === 'agent' && agent && <AgentPanel id={agent.id} />}
    </section>
  )
}

function authorName(id: string, agents: Map<string, MsgAgent>): string {
  if (id === 'brendon') return 'You'
  if (id === 'system') return 'Valkyrie'
  return agents.get(id)?.name ?? id
}

function MessageRow({ m, prev, agents }: { m: Msg; prev?: Msg; agents: Map<string, MsgAgent> }) {
  const now = useTick(60_000)
  const grouped = prev && prev.author === m.author && Date.parse(m.createdAt) - Date.parse(prev.createdAt) < 10 * 60_000 && !m.proposal
  const newDay = !prev || NY_KEY.format(Date.parse(prev.createdAt)) !== NY_KEY.format(Date.parse(m.createdAt))
  return (
    <>
      {newDay && <div className="mx-day"><span>{NY_DAY.format(Date.parse(m.createdAt))}</span></div>}
      <article className="mx-msg" data-author={m.author === 'brendon' ? 'me' : m.author === 'system' ? 'system' : 'agent'} data-grouped={(grouped && !newDay) || undefined}>
        {!(grouped && !newDay) && (
          <div className="mx-msg-head">
            <b>{authorName(m.author, agents)}</b>
            <time title={`${NY_DAY.format(Date.parse(m.createdAt))}, ${NY_TIME.format(Date.parse(m.createdAt))} ET`}>{when(m.createdAt, now)}</time>
          </div>
        )}
        <Markdown className="mx-md">{m.text}</Markdown>
        {m.refs.length > 0 && <Refs refs={m.refs} />}
        {m.proposal && <ProposalCard p={m.proposal} />}
      </article>
    </>
  )
}

function Refs({ refs }: { refs: Ref[] }) {
  const items: ReactNode[] = refs.map((r, i) => {
    if (r.type === 'ticket') return <a key={i} className="mx-ref" href={r.url} target="_blank" rel="noopener noreferrer">{r.number}{r.title ? ` · ${r.title}` : ''}</a>
    if (r.type === 'mail') {
      const label = `Mail${r.from ? ` from ${r.from}` : ''}${r.subject ? `: ${r.subject}` : ''}`
      return r.url ? <a key={i} className="mx-ref" href={r.url} target="_blank" rel="noopener noreferrer">{label}</a> : <span key={i} className="mx-ref">{label}</span>
    }
    if (r.type === 'link') return <a key={i} className="mx-ref" href={r.url} target="_blank" rel="noopener noreferrer">{r.label || r.url.replace(/^https:\/\//, '').slice(0, 60)}</a>
    return null
  })
  return <div className="mx-refs">{items}</div>
}

// --------------------------------------------------------------- proposals ---

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v))

function ProposalCard({ p }: { p: Proposal }) {
  const qc = useQueryClient()
  const mail = p.kind === 'mail_reply'
  const [body, setBody] = useState(str(p.payload.body))
  const [declining, setDeclining] = useState(false)
  const [reason, setReason] = useState('')
  const pending = p.status === 'pending' || p.status === 'failed'
  const refresh = () => qc.invalidateQueries({ queryKey: ['msg'] })
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
  const pl = p.payload
  const cc = Array.isArray(pl.cc) ? (pl.cc as string[]) : []

  return (
    <div className="mx-prop" data-status={p.status}>
      <div className="mx-prop-head">
        <b>{p.title}</b>
        <span className="mx-prop-state">{
          p.status === 'pending' ? 'waiting for you'
            : p.status === 'running' ? (mail ? 'with thor' : 'working')
              : p.status === 'done' ? 'done' : p.status === 'declined' ? 'declined' : 'failed'
        }</span>
      </div>
      {mail && (
        <dl className="mx-prop-meta">
          <dt>To</dt><dd>{str(pl.toName) ? `${str(pl.toName)} <${str(pl.to)}>` : str(pl.to)}</dd>
          {pl.replyAll ? <><dt>Cc</dt><dd>everyone on the thread</dd></> : cc.length > 0 && <><dt>Cc</dt><dd>{cc.join(', ')}</dd></>}
          <dt>Subject</dt><dd>RE: {str(pl.subject).replace(/^re:\s*/i, '')}</dd>
        </dl>
      )}
      {p.kind === 'ticket_note' && <pre className="mx-prop-body">{str(pl.title)}{'\n\n'}{str(pl.text)}</pre>}
      {p.kind === 'ticket_create' && <pre className="mx-prop-body">{str(pl.company)}: {str(pl.title)}{'\n\n'}{str(pl.description)}</pre>}
      {mail && (pending
        ? <textarea className="mx-prop-edit" value={body} onChange={(e) => setBody(e.target.value)} rows={Math.min(16, Math.max(5, body.split('\n').length + 1))} aria-label="The draft" />
        : <pre className="mx-prop-body">{str(pl.body)}</pre>)}
      {mail && pending && <p className="mx-prop-hint">"Thank you," and your signature are added when it goes out.</p>}
      {p.result && p.status !== 'pending' && <p className="mx-prop-result">{p.result}</p>}
      {pending && !declining && (
        <div className="mx-prop-acts">
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
        <form className="mx-prop-decline" onSubmit={(e) => { e.preventDefault(); decline.mutate() }}>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why (optional, the agent learns from it)" autoFocus />
          <Button kind="link" type="button" disabled={decline.isPending} onPress={() => decline.mutate()}>Decline</Button>
          <Button kind="link" type="button" onPress={() => setDeclining(false)}>Keep</Button>
        </form>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- composer ---

function Composer({ channelId, channel, agent }: { channelId: string; channel: MsgChannel | null; agent: MsgAgent | null }) {
  const qc = useQueryClient()
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  const send = useMutation({
    mutationFn: (t: string) => postMessage(channelId, t),
    onSuccess: (r) => {
      setText('')
      if (channel?.kind === 'team' && !r.woke.length) toast('Nobody was mentioned, so no agent will answer. Mention one with @.', { ms: 5000 })
      void qc.invalidateQueries({ queryKey: ['msg'] })
    },
    onError: (e) => toast(apiErrorText(e, 'Valkyrie did not answer'), { ms: 4000 }),
  })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(180, el.scrollHeight)}px`
  }, [text])
  const submit = () => {
    const t = text.trim()
    if (t && !send.isPending) send.mutate(t)
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends with a keyboard; a touch keyboard's return is a new line
    if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
      e.preventDefault()
      submit()
    }
  }
  const hint = channel?.kind === 'team' ? 'Message the team. Mention an agent with @' : agent ? `Message ${agent.name}` : 'Message'
  return (
    <form className="mx-compose" onSubmit={(e) => { e.preventDefault(); submit() }}>
      <textarea ref={ref} rows={1} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} placeholder={hint} aria-label={hint} />
      <Button kind="line" lit={Boolean(text.trim())} type="button" disabled={!text.trim() || send.isPending} onPress={submit}>Send</Button>
    </form>
  )
}

// ----------------------------------------------------------------- tickets ---

function Tickets({ franchise }: { franchise: string }) {
  const q = useQuery({ queryKey: ['msg', 'tickets', franchise], queryFn: () => fetchTickets(franchise) })
  const now = useTick(60_000)
  if (q.isError && !q.data) return <p className="mx-quiet mx-pad">{apiErrorText(q.error, 'Could not read the tracker')}</p>
  if (!q.data) return <p className="mx-quiet mx-pad">Reading the tracker</p>
  const c = q.data.counts
  return (
    <div className="mx-tickets">
      <p className="mx-quiet">{c.open} open · {c.mine} yours · {c.needsBrendon} need you · Monitoring Alert left out</p>
      {q.data.tickets.map((t) => (
        <a key={t.id} className="mx-ticket" href={t.url} target="_blank" rel="noopener noreferrer" data-need={t.needsBrendon || undefined}>
          <span className="mx-ticket-top">
            <b>{t.number}</b>
            <span>{t.title}</span>
          </span>
          <span className="mx-ticket-meta">
            {t.company} · {t.status} · {t.assignee ?? 'unassigned'}{t.lastActivity ? ` · ${when(t.lastActivity, now)}` : ''}{t.waitingOn ? ` · waiting on ${t.waitingOn}` : ''}
          </span>
          {(t.summary || t.next) && <span className="mx-ticket-note">{t.summary}{t.next ? ` Next: ${t.next}` : ''}</span>}
        </a>
      ))}
    </div>
  )
}

// ------------------------------------------------------------------- agent ---

function AgentPanel({ id }: { id: string }) {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['msg', 'agent', id], queryFn: () => fetchAgent(id) })
  const now = useTick(60_000)
  const refresh = () => qc.invalidateQueries({ queryKey: ['msg'] })
  const patch = useMutation({
    mutationFn: (p: { enabled?: boolean; model?: string }) => patchAgent(id, p),
    onSuccess: () => void refresh(),
    onError: (e) => toast(apiErrorText(e, 'Valkyrie did not answer'), { ms: 4000 }),
  })
  const check = useMutation({
    mutationFn: () => checkAgent(id),
    onSuccess: () => { toast('Asked for a check'); void refresh() },
    onError: (e) => toast(apiErrorText(e, 'Valkyrie did not answer'), { ms: 4000 }),
  })
  if (!q.data) return <p className="mx-quiet mx-pad">{q.isError ? apiErrorText(q.error, 'Could not read the agent') : 'Reading the agent'}</p>
  const a = q.data.agent
  return (
    <div className="mx-agent">
      <p className="mx-agent-role">{a.role}</p>
      <div className="mx-agent-acts">
        <Button kind="line" disabled={!a.enabled || check.isPending} onPress={() => check.mutate()}>Check now</Button>
        <Button kind="link" onPress={() => patch.mutate({ enabled: !a.enabled })}>{a.enabled ? 'Pause this agent' : 'Turn it back on'}</Button>
      </div>
      <div className="mx-agent-models" role="group" aria-label="Model">
        {MODELS.map((m) => (
          <Press key={m.id} className="mx-chip" data-on={a.model === m.id || undefined} onPress={() => patch.mutate({ model: m.id })}>{m.label}</Press>
        ))}
      </div>
      <h3 className="mx-group-label">Notebook</h3>
      {a.notebook.trim() ? <Markdown className="mx-md mx-notebook">{a.notebook}</Markdown> : <p className="mx-quiet">Empty. The agent writes what it learns here.</p>}
      <h3 className="mx-group-label">Recent runs</h3>
      {q.data.runs.length === 0 && <p className="mx-quiet">No runs yet.</p>}
      <div className="mx-runs">
        {q.data.runs.map((r) => (
          <div key={r.id} className="mx-run" data-status={r.status}>
            <span className="mx-run-top">
              <b>{when(r.startedAt, now)}</b>
              <span>{r.trigger}</span>
              <span className="mx-run-cost">{r.durationMs ? `${Math.round(r.durationMs / 1000)}s` : ''}{r.turns ? ` · ${r.turns} turns` : ''}</span>
            </span>
            <span className="mx-run-sum">{r.status === 'failed' ? r.error : r.summary}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
