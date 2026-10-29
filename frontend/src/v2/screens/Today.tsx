import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Button, Press, Section, toast } from '../kit/ui'
import { Icon } from '../kit/icons'
import { useShell } from '../kit/shell'
import { ago, useCalendar, useOpenTasks, useSessions, useTick, type EventVM, type SessionVM } from '../kit/data'
import { apiErrorText } from '../../lib/api'
import { fetchInbox, type InboxItem } from '../../lib/inboxApi'
import { clockOf, dueLabel, dueState, nyDayKey } from '../../lib/taskDue'
import { taskKey, updateTask, type Task } from '../../lib/tasksApi'
import { fetchBrief, fetchCaptures, refreshBrief, sendCapture, undoCapture, type Capture } from '../../lib/todayApi'
import './today.css'

// Dashboard > Today (/m/dashboard/today): the day in one place. The Capture
// line at the top files whatever is typed or dictated (backend/src/lib/capture.ts:
// Claude decides task, reminder, event or note, the backend does it), then the
// morning brief Claude wrote at 7:30 (lib/brief.ts), then what is left on
// today's calendar, the tasks that are overdue or due today (the box ticks
// them), the unread inbox with alerts first, and the sessions that are asking
// or working. Every block opens its own page for the rest. All times are New
// York time. Blocks with nothing in them say so in one line.

const NY_HEAD = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric' })
const NY_CLOCK = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })

export default function Today({ active }: { active: boolean }) {
  const now = useTick(30_000)
  const today = nyDayKey(now)
  // the dashboard's own query (calendar7), so switching between them costs no fetch
  const cal = useCalendar(7)
  const tasks = useOpenTasks()
  const inbox = useQuery({ queryKey: ['inbox', 'open', ''], queryFn: () => fetchInbox('open'), refetchInterval: () => (document.hidden || !active ? false : 30_000) })
  const sessions = useSessions()

  const events = useMemo(() => (cal.data ?? []).filter((e) => nyDayKey(e.start) <= today && (e.allDay ? nyDayKey(e.end - 1) >= today : nyDayKey(e.end) >= today)), [cal.data, today])
  const left = events.filter((e) => e.allDay || e.end > now)
  const due = useMemo(() => (tasks.data?.tasks ?? []).filter((t) => t.due && (dueState(t.due, now) === 'overdue' || dueState(t.due, now) === 'today')), [tasks.data, now])
  const unread = useMemo(() => (inbox.data?.items ?? []).filter((i) => !i.readAt)
    .sort((a, b) => (a.level === 'alert' ? 0 : 1) - (b.level === 'alert' ? 0 : 1) || b.lastAt.localeCompare(a.lastAt)), [inbox.data])
  const busy = useMemo(() => (sessions.data ?? []).filter((s) => s.live && (s.activity === 'asking' || s.activity === 'working'))
    .sort((a, b) => (a.activity === 'asking' ? 0 : 1) - (b.activity === 'asking' ? 0 : 1) || b.last - a.last), [sessions.data])

  const sum = [
    cal.data ? (() => { const n = left.filter((e) => !e.allDay).length; return `${n} ${n === 1 ? 'event' : 'events'} left` })() : null,
    tasks.data ? `${due.length} due` : null,
    inbox.data ? `${unread.length} unread` : null,
  ].filter(Boolean).join(' · ')

  return (
    <div className="vl-screen td">
      <header className="td-head">
        <h2>{NY_HEAD.format(now)}</h2>
        {/* always there, so the counts arriving never push the Capture line down */}
        <span className="td-sum">{sum || '\u00a0'}</span>
      </header>
      <CaptureLine active={active} today={today} />
      <BriefBlock active={active} />
      <div className="td-cols">
        <div className="td-col">
          <Schedule events={events} left={left} now={now} today={today} tomorrow={(cal.data ?? []).find((e) => !e.allDay && nyDayKey(e.start) > today) ?? null} failed={cal.failed && !cal.data} />
          <DueTasks due={due} open={tasks.data?.tasks.length ?? null} now={now} failed={tasks.failed && !tasks.data} />
        </div>
        <div className="td-col">
          <UnreadInbox items={unread} loaded={!!inbox.data} failed={inbox.isError && !inbox.data} now={now} />
          <Busy list={busy} loaded={!!sessions.data} failed={sessions.failed && !sessions.data} now={now} />
        </div>
      </div>
    </div>
  )
}

// ---------- Capture ----------

function CaptureLine({ active, today }: { active: boolean; today: string }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [text, setText] = useState('')
  const q = useQuery({
    queryKey: ['captures'],
    queryFn: fetchCaptures,
    refetchInterval: (query) => (!active || document.hidden ? false : query.state.data?.some((c) => c.status === 'filing') ? 1500 : 30_000),
  })
  const recent = (q.data ?? []).filter((c) => nyDayKey(Date.parse(c.createdAt)) === today).slice(0, 4)
  // a capture that just finished filing changed a list somewhere: refetch the ones Today shows
  const filing = (q.data ?? []).filter((c) => c.status === 'filing').map((c) => c.id).join(',')
  const wasFiling = useRef(filing)
  useEffect(() => {
    if (wasFiling.current && wasFiling.current !== filing) {
      void qc.invalidateQueries({ queryKey: ['tasks'] })
      void qc.invalidateQueries({ queryKey: ['v2', 'tasks-open'] })
      void qc.invalidateQueries({ queryKey: ['inbox'] })
    }
    wasFiling.current = filing
  }, [filing, qc])
  const refreshAll = () => {
    void qc.invalidateQueries({ queryKey: ['captures'] })
    void qc.invalidateQueries({ queryKey: ['tasks'] })
    void qc.invalidateQueries({ queryKey: ['v2', 'tasks-open'] })
    void qc.invalidateQueries({ queryKey: ['inbox'] })
  }
  const send = useMutation({
    mutationFn: (t: string) => sendCapture(t),
    onSuccess: (c) => {
      setText('')
      qc.setQueryData<Capture[]>(['captures'], (d) => [c, ...(d ?? [])])
      void qc.invalidateQueries({ queryKey: ['captures'] })
    },
    onError: (e) => toast(`Could not capture it: ${apiErrorText(e, 'Valkyrie did not answer')}`, { ms: 4000 }),
  })
  const undo = useMutation({
    mutationFn: (id: string) => undoCapture(id),
    onSuccess: (c) => { toast(c.summary); refreshAll() },
    onError: (e) => toast(`Could not undo it: ${apiErrorText(e, 'Valkyrie did not answer')}`, { ms: 4000 }),
  })
  const go = () => {
    const t = text.trim()
    if (t && !send.isPending) send.mutate(t)
  }
  return (
    <section className="td-sec td-capture" aria-label="Capture">
      <form className="td-cap-line" data-no-swipe onSubmit={(e) => { e.preventDefault(); go() }}>
        <Icon name="add" size={15} tone={text.trim() ? 'fg' : 'dim'} />
        <input
          className="td-field"
          value={text}
          maxLength={500}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); go() } }}
          placeholder="Capture a task, reminder or note"
          aria-label="Capture"
          enterKeyHint="send"
          autoComplete="off"
        />
        {text.trim() !== '' && (
          <Press className="td-send" disabled={send.isPending} onPress={go}>{send.isPending ? 'Sending' : 'Capture'}</Press>
        )}
      </form>
      {recent.length > 0 && (
        <ul className="td-caps">
          {recent.map((c) => (
            <li key={c.id} className="td-cap" data-status={c.status}>
              <span className="td-cap-text">{c.text}</span>
              <span className="td-cap-where" title={c.error ?? undefined}>{c.status === 'filing' ? 'Filing' : c.summary}</span>
              <span className="td-cap-acts">
                {c.url && c.status !== 'undone' && c.status !== 'filing' && (
                  <Button kind="link" onPress={() => navigate(c.url!, { state: { v2Back: true } })}>Open</Button>
                )}
                {c.undoable && <Button kind="link" disabled={undo.isPending} onPress={() => undo.mutate(c.id)}>Undo</Button>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// ---------- the brief ----------

function BriefBlock({ active }: { active: boolean }) {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['brief'],
    queryFn: fetchBrief,
    refetchInterval: (query) => (!active || document.hidden ? false : query.state.data?.status === 'writing' ? 3000 : 120_000),
  })
  const write = useMutation({
    mutationFn: refreshBrief,
    onSuccess: () => {
      qc.setQueryData(['brief'], (b: unknown) => ({ ...(b as object ?? {}), status: 'writing' }))
      void qc.invalidateQueries({ queryKey: ['brief'] })
    },
    onError: (e) => toast(`Could not start the brief: ${apiErrorText(e, 'Valkyrie did not answer')}`, { ms: 4000 }),
  })
  const b = q.data
  const lines = b?.status === 'done' ? b.text.split('\n').filter(Boolean) : []
  const action = b?.status === 'writing' || write.isPending
    ? <span className="td-note vl-pulse">Writing</span>
    : <Button kind="link" onPress={() => write.mutate()}>{b?.status === 'done' ? 'Rewrite' : 'Write it now'}</Button>
  return (
    <section className="td-sec td-brief" aria-label="Brief">
      <Section icon="claude" lit={lines.length > 0} action={action}>Brief</Section>
      {lines.length > 0 ? (
        <div className="td-brief-text">
          {lines.map((l, k) => <p key={k} data-first={k === 0 || undefined}>{l}</p>)}
          <span className="td-note">Written {NY_CLOCK.format(Date.parse(b!.updatedAt))}</span>
        </div>
      ) : b?.status === 'failed' ? (
        <p className="td-quiet" title={b.error ?? undefined}>The brief could not be written. {b.error?.includes('limit') ? 'Every account is at its limit.' : ''}</p>
      ) : b?.status === 'writing' ? (
        <p className="td-quiet">Claude is reading the day.</p>
      ) : (
        <p className="td-quiet">{q.isError ? 'The brief is not answering.' : 'The brief is written at 7:30 AM.'}</p>
      )}
    </section>
  )
}

// ---------- the calendar ----------

function Schedule({ events, left, now, today, tomorrow, failed }: {
  events: EventVM[]; left: EventVM[]; now: number; today: string; tomorrow: EventVM | null; failed: boolean
}) {
  const navigate = useNavigate()
  const open = (date = today) => navigate(`/m/calendar?view=day&date=${date}`, { state: { v2Back: true } })
  const earlier = events.length - left.length
  return (
    <section className="td-sec" aria-label="Schedule">
      <Section icon="calendar" lit={left.some((e) => !e.allDay && e.start <= now)} action={<Button kind="link" onPress={() => open()}>Calendar</Button>}>Schedule</Section>
      {failed ? <p className="td-quiet">The calendar is not answering.</p> : (
        <div className="td-rows">
          {left.length === 0 && <p className="td-quiet">{events.length ? 'Nothing else today.' : 'Nothing today.'}</p>}
          {left.map((e) => {
            const live = !e.allDay && e.start <= now
            return (
              <Press key={e.id} className="td-row" data-live={live || undefined} onPress={() => open()}>
                <span className="td-when">{e.allDay ? 'All day' : live ? 'Now' : NY_CLOCK.format(e.start)}</span>
                <span className="td-what">{e.title || 'Busy'}</span>
                {!e.allDay && <span className="td-meta">{live ? `until ${NY_CLOCK.format(e.end)}` : e.location}</span>}
              </Press>
            )
          })}
          {earlier > 0 && <p className="td-note">{earlier} earlier today</p>}
          {tomorrow && (
            <Press className="td-row td-next" onPress={() => open(nyDayKey(tomorrow.start))}>
              <span className="td-when">Next</span>
              <span className="td-what">{tomorrow.title || 'Busy'}</span>
              <span className="td-meta">{new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(tomorrow.start)} {NY_CLOCK.format(tomorrow.start)}</span>
            </Press>
          )}
        </div>
      )}
    </section>
  )
}

// ---------- tasks ----------

function DueTasks({ due, open, now, failed }: { due: Task[]; open: number | null; now: number; failed: boolean }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set())
  const tick = useMutation({
    mutationFn: (t: Task) => updateTask(t.ref, { done: true }),
    onMutate: (t) => setTicked((s) => new Set(s).add(taskKey(t.ref))),
    onSuccess: (_r, t) => toast(`Done: ${t.text}`, {
      action: { label: 'Undo', run: () => { updateTask(t.ref, { done: false }).then(() => { setTicked((s) => { const n = new Set(s); n.delete(taskKey(t.ref)); return n }); refresh() }, () => toast('Could not reopen it')) } },
    }),
    onError: (e, t) => {
      setTicked((s) => { const n = new Set(s); n.delete(taskKey(t.ref)); return n })
      toast(`Could not tick it: ${apiErrorText(e, 'Valkyrie did not answer')}`, { ms: 4000 })
    },
    onSettled: () => refresh(),
  })
  function refresh() {
    void qc.invalidateQueries({ queryKey: ['v2', 'tasks-open'] })
    void qc.invalidateQueries({ queryKey: ['tasks'] })
  }
  const shown = due.filter((t) => !ticked.has(taskKey(t.ref)))
  const late = shown.filter((t) => dueState(t.due!, now) === 'overdue').length
  const toList = () => navigate('/m/tasks', { state: { v2Back: true } })
  return (
    <section className="td-sec" aria-label="Due today">
      <Section icon="tasks" lit={shown.length > 0} action={<Button kind="link" onPress={toList}>{open != null ? `All tasks (${open})` : 'All tasks'}</Button>}>
        {late ? `Due · ${late} overdue` : 'Due'}
      </Section>
      {failed ? <p className="td-quiet">Tasks are not answering.</p> : (
        <div className="td-rows">
          {open != null && shown.length === 0 && <p className="td-quiet">Nothing due today.</p>}
          {shown.map((t) => {
            const st = dueState(t.due!, now)
            return (
              <div key={taskKey(t.ref)} className="td-task">
                <Press className="td-box" role="checkbox" aria-checked={false} aria-label={`Done: ${t.text}`} onPress={() => tick.mutate(t)} />
                <Press className="td-row td-task-main" onPress={toList}>
                  <span className="td-what">{t.text}</span>
                  <span className="td-meta" data-state={st}>{st === 'overdue' ? dueLabel(t.due!, now) : t.due!.length > 10 ? clockOf(t.due!.slice(11, 16)) : t.project?.name ?? t.area}</span>
                </Press>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

// ---------- inbox ----------

function UnreadInbox({ items, loaded, failed, now }: { items: InboxItem[]; loaded: boolean; failed: boolean; now: number }) {
  const navigate = useNavigate()
  const open = (id?: number) => navigate(id ? `/m/inbox?item=${id}` : '/m/inbox', { state: { v2Back: true } })
  const alerts = items.filter((i) => i.level === 'alert').length
  return (
    <section className="td-sec" aria-label="Inbox">
      <Section icon="inbox" lit={items.length > 0} action={<Button kind="link" onPress={() => open()}>Inbox</Button>}>
        {alerts ? `Inbox · ${alerts} ${alerts === 1 ? 'alert' : 'alerts'}` : 'Inbox'}
      </Section>
      {failed ? <p className="td-quiet">The inbox is not answering.</p> : (
        <div className="td-rows">
          {loaded && items.length === 0 && <p className="td-quiet">Nothing unread.</p>}
          {items.slice(0, 5).map((i) => (
            <Press key={i.id} className="td-row" data-level={i.level} onPress={() => open(i.id)}>
              <span className="td-mark" aria-hidden />
              <span className="td-what">{i.title}</span>
              <span className="td-meta">{i.source} · {ago(Date.parse(i.lastAt), now)}</span>
            </Press>
          ))}
          {items.length > 5 && <Press className="td-row td-more" onPress={() => open()}>{items.length - 5} more unread</Press>}
        </div>
      )}
    </section>
  )
}

// ---------- sessions ----------

function Busy({ list, loaded, failed, now }: { list: SessionVM[]; loaded: boolean; failed: boolean; now: number }) {
  const { go } = useShell()
  const asking = list.filter((s) => s.activity === 'asking').length
  const open = () => go('ai', 'sessions')
  return (
    <section className="td-sec" aria-label="Sessions">
      <Section icon="claude" lit={asking > 0} action={<Button kind="link" onPress={open}>Sessions</Button>}>
        {asking ? `Sessions · ${asking} asking` : 'Sessions'}
      </Section>
      {failed ? <p className="td-quiet">The session board is not answering.</p> : (
        <div className="td-rows">
          {loaded && list.length === 0 && <p className="td-quiet">No session is working or asking.</p>}
          {list.slice(0, 5).map((s) => (
            <Press key={s.id} className="td-row" data-asking={s.activity === 'asking' || undefined} onPress={open}>
              <span className="td-when">{s.activity === 'asking' ? 'Asking' : 'Working'}</span>
              <span className="td-what">{s.title || s.project || 'Untitled session'}</span>
              <span className="td-meta">{s.host} · {s.last ? ago(s.last, now) : '--'}</span>
            </Press>
          ))}
        </div>
      )}
    </section>
  )
}
