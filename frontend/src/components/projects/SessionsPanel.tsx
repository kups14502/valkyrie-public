import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Check, Link2, Square, Undo2, Unlink } from 'lucide-react'
import {
  apiErrorText, killTermSession, setSessionDone, stopSessionOnHost, termLabel,
  type SessionActivity, type TermSession, type WorkSession,
} from '../../lib/api'
import { PROJ_KEYS, unlinkProjSession, type ProjectDoc, type ProjectTerm } from '../../lib/projectsApi'
import { AddSessionSheet } from './AddSessionSheet'
import { BTN_TEXT } from './Sheet'

// The project's sessions as a narrow list for the left column. The Sessions
// page board does the same jobs with rows built for a full-width page; here a
// session is two lines, and its actions are icons that show on hover.

const TONE: Record<SessionActivity, string> = {
  working: 'var(--color-accent)',
  asking: 'var(--color-warning)',
  idle: 'var(--color-success)',
  closed: 'var(--color-border-strong)',
}
const WORD: Record<SessionActivity, string> = {
  working: 'working',
  asking: 'waiting on you',
  idle: 'idle',
  closed: '',
}

const age = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const m = Math.round((Date.now() - ms) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

const httpStatus = (e: unknown): number | null =>
  (e as { response?: { status?: number } } | null)?.response?.status ?? null

const paneConversation = (t: TermSession) => t.sessionId || (t.mode === 'resume' ? t.target : '')

type Item = {
  key: string
  sessionId: string | null
  title: string
  activity: SessionActivity
  live: boolean
  done: boolean
  at: number
  pane: string | null
  row: WorkSession | null
  note: string
}

const ICON = 'inline-flex h-8 w-7 shrink-0 items-center justify-center text-[var(--color-text-faint)] transition disabled:opacity-30'

function SessionItem({ item, selected, term, onStop, onDone, onUnlink }: {
  item: Item
  selected: boolean
  term: ProjectTerm
  onStop: (i: Item) => Promise<void>
  onDone: (i: Item) => Promise<void>
  onUnlink: (i: Item) => Promise<void>
}) {
  const [armed, setArmed] = useState<'stop' | 'unlink' | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(null), 4000)
    return () => clearTimeout(t)
  }, [armed])

  // Running in a window on thor, not in a pane here: resuming it would put a
  // second Claude on the same transcript, so the row only says where it is.
  const runningElsewhere = item.live && !item.pane
  const open = () => {
    if (item.pane) term.open(item.pane)
    else if (item.sessionId && !item.live) void term.resume(item.sessionId, item.title)
  }
  const act = async (which: 'stop' | 'unlink' | 'done') => {
    if (which !== 'done' && armed !== which) { setArmed(which); return }
    setArmed(null)
    setBusy(true)
    try {
      await (which === 'stop' ? onStop(item) : which === 'unlink' ? onUnlink(item) : onDone(item))
    } finally {
      setBusy(false)
    }
  }
  const meta = [age(item.at), WORD[item.activity], item.pane ? 'in page' : runningElsewhere ? 'in a window on thor' : '']
    .filter(Boolean).join(' · ')

  return (
    <li className={`group flex items-start gap-2 border-l-2 py-1.5 pl-2 ${selected ? 'border-[var(--color-accent)] bg-[rgba(var(--color-accent-rgb),0.06)]' : 'border-transparent'}${busy ? ' opacity-50' : ''}`}>
      <span
        aria-hidden
        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full${item.activity === 'working' ? ' animate-pulse' : ''}`}
        style={{ background: TONE[item.activity] }}
      />
      <button
        type="button"
        onClick={open}
        disabled={runningElsewhere || term.busy}
        title={runningElsewhere ? 'Running in a window on thor. Stop it there, or here, to reopen it in the page.' : item.pane ? 'Show it' : 'Reopen it here'}
        className="min-w-0 flex-1 text-left disabled:cursor-default"
      >
        <span className={`block truncate text-[13px] ${item.done ? 'text-[var(--color-text-faint)] line-through' : 'text-[var(--color-text)]'}`}>{item.title}</span>
        {meta && <span className="block truncate text-[10px] text-[var(--color-text-faint)]">{meta}</span>}
        {item.note && <span className="block truncate text-[10px] text-[var(--color-text-dim)]" title={item.note}>{item.note}</span>}
      </button>
      <div className="flex shrink-0 items-center lg:opacity-0 lg:transition-opacity lg:group-hover:opacity-100 lg:group-focus-within:opacity-100">
        {(item.pane || item.live) && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act('stop')}
            title={armed === 'stop' ? 'Click again to stop it' : 'Stop it. The conversation stays resumable.'}
            aria-label="Stop"
            className={`${ICON} ${armed === 'stop' ? 'text-[var(--color-danger)]' : 'hover:text-[var(--color-danger)]'}`}
          >
            <Square size={12} />
          </button>
        )}
        {item.row && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act('done')}
            title={item.done ? 'Put it back on the list' : 'Finished with it. Hides it.'}
            aria-label={item.done ? 'Undo done' : 'Done'}
            className={`${ICON} hover:text-[var(--color-accent)]`}
          >
            {item.done ? <Undo2 size={12} /> : <Check size={13} />}
          </button>
        )}
        {item.sessionId && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act('unlink')}
            title={armed === 'unlink' ? 'Click again to take it off this project' : 'Take it off this project. The session itself is untouched.'}
            aria-label="Unlink"
            className={`${ICON} ${armed === 'unlink' ? 'text-[var(--color-danger)]' : 'hover:text-[var(--color-danger)]'}`}
          >
            <Unlink size={12} />
          </button>
        )}
      </div>
    </li>
  )
}

export function SessionsPanel({ projectId, doc, term, rows, terms, titles }: {
  projectId: string
  doc: ProjectDoc
  term: ProjectTerm
  rows: WorkSession[]
  terms: TermSession[]
  titles: Map<string, string>
}) {
  const qc = useQueryClient()
  const [showDone, setShowDone] = useState(false)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')

  const linkedIds = new Set(doc.sessions.map((s) => s.sessionId))
  const notes = new Map(doc.sessions.filter((s) => s.statusNote).map((s) => [s.sessionId, s.statusNote]))
  const panes = terms.filter((t) => !t.dead && ((t.projectId !== '' && t.projectId === projectId) || linkedIds.has(paneConversation(t))))
  const paneFor = new Map<string, TermSession>()
  for (const t of panes) {
    const c = paneConversation(t)
    if (c) paneFor.set(c, t)
  }

  const items: Item[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    if (r.host !== 'thor' || !linkedIds.has(r.sessionId)) continue
    const pane = paneFor.get(r.sessionId) ?? null
    seen.add(r.sessionId)
    items.push({
      key: r.sessionId, sessionId: r.sessionId, title: r.title || r.sessionId.slice(0, 8), activity: r.activity,
      live: r.live, done: r.done, at: r.lastActivityUtc ? Date.parse(r.lastActivityUtc) : 0,
      pane: pane?.name ?? null, row: r, note: notes.get(r.sessionId) ?? '',
    })
  }
  // A pane whose conversation the board has not listed yet (Claude registers
  // a few seconds after it starts) is still this project's session.
  for (const t of panes) {
    const c = paneConversation(t)
    if (c && seen.has(c)) continue
    items.push({
      key: t.name, sessionId: c || null, title: termLabel(t, titles), activity: 'working', live: true, done: false,
      at: t.activityAt || t.createdAt, pane: t.name, row: null, note: c ? notes.get(c) ?? '' : '',
    })
  }
  const rank = (i: Item) => (i.activity === 'asking' ? 3 : i.pane ? 2 : i.live ? 1 : 0)
  const open = items.filter((i) => !i.done).sort((a, b) => rank(b) - rank(a) || b.at - a.at)
  const done = items.filter((i) => i.done).sort((a, b) => b.at - a.at)

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['sessionList'] })
    void qc.invalidateQueries({ queryKey: ['term', 'sessions'] })
  }
  const run = async (fn: () => Promise<unknown>, what: string) => {
    setError('')
    try {
      await fn()
    } catch (e) {
      // 404: it ended between the last poll and the click.
      if (httpStatus(e) !== 404) setError(apiErrorText(e, what))
    }
    refresh()
  }
  const onStop = (i: Item) => run(async () => {
    if (i.pane) await killTermSession(i.pane)
    else if (i.sessionId) await stopSessionOnHost(i.sessionId)
  }, 'could not stop it')
  const onDone = (i: Item) => run(() => setSessionDone(i.sessionId as string, !i.done), 'could not mark it')
  const onUnlink = (i: Item) => run(async () => {
    await unlinkProjSession(projectId, i.sessionId as string)
    void qc.invalidateQueries({ queryKey: PROJ_KEYS.doc(projectId) })
    void qc.invalidateQueries({ queryKey: PROJ_KEYS.list })
  }, 'could not unlink it')

  const itemProps = { term, onStop, onDone, onUnlink }

  return (
    <div>
      {error && <div className="mb-1 text-[11px] text-[var(--color-danger)]">{error}</div>}
      {open.length === 0 && done.length === 0 ? (
        <div className="py-2 text-[11px] text-[var(--color-text-faint)]">No sessions yet.</div>
      ) : (
        <ul>
          {open.map((i) => <SessionItem key={i.key} item={i} selected={i.pane !== null && i.pane === term.selected} {...itemProps} />)}
          {showDone && done.map((i) => <SessionItem key={i.key} item={i} selected={false} {...itemProps} />)}
        </ul>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-x-1">
        {done.length > 0 && (
          <button type="button" onClick={() => setShowDone((v) => !v)} className={BTN_TEXT}>
            {showDone ? 'hide done' : `${done.length} done`}
          </button>
        )}
        <button type="button" onClick={() => setAdding(true)} className={BTN_TEXT} title="Add a session that started somewhere else">
          <Link2 size={11} /> link one
        </button>
      </div>
      {adding && <AddSessionSheet projectId={projectId} doc={doc} onClose={() => setAdding(false)} />}
    </div>
  )
}
