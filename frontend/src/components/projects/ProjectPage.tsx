import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FileText, MessageSquare, Pencil, Play, Plus, SquareTerminal, X } from 'lucide-react'
import {
  apiErrorText, fetchSessionList, fetchTermSessions, killTermSession, termLabel, termPath,
  type TermSession, type WorkSession,
} from '../../lib/api'
import { relIso } from '../../lib/term'
import {
  PROJ_KEYS, actorLabel, fetchProjDoc, undoProjEvent,
  type ProjectDoc, type ProjectEvent, type ProjectTabProps,
} from '../../lib/projectsApi'
import { ActivityTab } from './ActivityTab'
import { AddTabSheet } from './AddTabSheet'
import { AutomationsTab } from './AutomationsTab'
import { ChecklistTab } from './ChecklistTab'
import { FilesTab } from './FilesTab'
import { LinksTab } from './LinksTab'
import { MarkdownTab } from './MarkdownTab'
import { ProjectEditSheet } from './ProjectEditSheet'
import { RemindersTab } from './RemindersTab'
import { SessionsPanel } from './SessionsPanel'
import { SidePanel } from './SidePanel'
import { BTN_ACCENT, BTN_GHOST, BTN_TEXT } from './Sheet'
import { useProjectLive } from './useProjectLive'
import { useProjectTerm, type ProjectTermState } from './useProjectTerm'

// The xterm chunk is the heaviest thing on the page and the phone never shows
// a pane here, so it loads only when the desktop column first needs it.
const TermPane = lazy(() => import('../TermPane'))

const WEEK_MS = 7 * 86_400_000
const NO_ROWS: WorkSession[] = []
const NO_TERMS: TermSession[] = []

// Underlined text, not boxes: a row of bordered buttons read as a toolbar and
// pushed the content halfway down a desktop screen (2026-10-06).
const TAB_CLS = '-mb-px shrink-0 whitespace-nowrap border-b-2 py-2.5 text-[11px] uppercase tracking-[0.14em] transition-colors sm:py-2'
const TAB_ON = 'border-[var(--color-accent)] text-[var(--color-accent)]'
const TAB_OFF = 'border-transparent text-[var(--color-text-dim)] hover:text-[var(--color-text)]'
const ICON_BTN = 'inline-flex h-9 w-9 shrink-0 items-center justify-center text-[var(--color-text-faint)] transition hover:text-[var(--color-accent)] disabled:opacity-40 sm:h-8 sm:w-8'
const LOADING = (
  <div className="py-16 text-center text-xs uppercase tracking-[0.3em] text-[var(--color-text-faint)]">&gt; loading<span className="cursor-blink">_</span></div>
)

const httpStatus = (e: unknown): number | null =>
  (e as { response?: { status?: number } } | null)?.response?.status ?? null

const ago = (iso: string | null) => {
  const r = relIso(iso)
  return r === 'now' ? 'just now' : r ? `${r} ago` : ''
}

const activeWithin = (iso: string | null, ms: number) => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) && Date.now() - t < ms
}

// The conversation a pane is running: a new pane is handed its id up front, a
// resume has always kept it in target.
const paneConversation = (t: TermSession) => t.sessionId || (t.mode === 'resume' ? t.target : '')

type Primary = { kind: 'answer' | 'continue' | 'resume' | 'new'; label: string; run: () => void }

function Toast({ projectId, event, titles, onClose }: {
  projectId: string
  event: ProjectEvent
  titles: Map<string, string>
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [force, setForce] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Restarted by every answer, so a 409 that asks for "undo anyway" does not
  // vanish before it can be pressed.
  useEffect(() => {
    if (busy) return
    const t = setTimeout(onClose, 8000)
    return () => clearTimeout(t)
  }, [onClose, busy, force, error])

  const undo = async () => {
    setBusy(true)
    setError('')
    try {
      await undoProjEvent(projectId, event.id, force || undefined)
      void qc.invalidateQueries({ queryKey: PROJ_KEYS.doc(projectId) })
      void qc.invalidateQueries({ queryKey: PROJ_KEYS.events(projectId) })
      void qc.invalidateQueries({ queryKey: PROJ_KEYS.list })
      onClose()
    } catch (e) {
      if (httpStatus(e) === 409 && !force) setForce(true)
      setError(apiErrorText(e, 'could not undo that'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-x-3 z-50 sm:left-auto sm:right-4 sm:w-96"
      // fixed is measured from the viewport, not from body's safe-area padding,
      // so a plain bottom-3 sits under the home indicator in the iPhone PWA.
      style={{ bottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}
    >
      {/* .panel is unlayered CSS with position: relative, which beats Tailwind's
          layered `fixed` on the same element, hence the wrapper. */}
      <div role="status" className="panel p-3 text-xs">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1 break-words text-[var(--color-text)]">
            <span className="text-[var(--color-accent)]">{actorLabel(event.actor, titles)}</span> {event.summary}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Dismiss"
            className="-m-1.5 shrink-0 p-1.5 text-[var(--color-text-faint)] transition hover:text-[var(--color-text)]"
          >
            <X size={13} />
          </button>
        </div>
        {(event.undoable || error) && (
          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            {event.undoable && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void undo()}
                className="-mx-2 inline-flex min-h-9 items-center px-2 text-[10px] uppercase tracking-[0.14em] text-[var(--color-accent)] transition hover:text-[var(--color-text)] disabled:opacity-40"
              >
                {busy ? 'undoing' : force ? 'undo anyway' : 'undo'}
              </button>
            )}
            {error && <span className="min-w-0 text-[11px] text-[var(--color-danger)]">{error}</span>}
          </div>
        )}
      </div>
    </div>
  )
}

function SelectedTerm({ name, term, terms, settled, titles, boardIds, doc, back }: {
  name: string
  term: ProjectTermState
  terms: TermSession[]
  settled: boolean
  titles: Map<string, string>
  boardIds: Set<string>
  doc: ProjectDoc
  back: string
}) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [stopArmed, setStopArmed] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [stopErr, setStopErr] = useState('')

  useEffect(() => {
    if (!stopArmed) return
    const t = setTimeout(() => setStopArmed(false), 4000)
    return () => clearTimeout(t)
  }, [stopArmed])

  const session = terms.find((t) => t.name === name) ?? null
  // Only once the list has settled: while a refetch is in flight, a pane that
  // is missing from the cached list may simply be newer than it.
  const gone = !session && settled
  // A pane that has left the list no longer says what it was running; the
  // project's own link row for that tmux name still does.
  const link = doc.sessions.find((l) => l.tmuxName === name)
  const convo = (session ? paneConversation(session) : '') || link?.sessionId || ''
  // The link is written when the pane opens, before Claude runs, so a launch
  // that died early leaves an id no transcript has. Terminal.tsx's reopen asks
  // the same question: did the board ever see it, or was it a resume.
  const resumable = !!convo && (boardIds.has(convo) || session?.mode === 'resume' || link?.mode === 'resume')
  const label = session ? termLabel(session, titles) : (convo && titles.get(convo)) || name
  const dot = term.conn === 'live'
    ? 'var(--color-accent)'
    : term.conn === 'connecting' ? 'var(--color-accent-2)' : 'var(--color-text-faint)'

  const stop = async () => {
    if (!stopArmed) { setStopArmed(true); return }
    setStopArmed(false)
    setStopping(true)
    setStopErr('')
    try {
      await killTermSession(name)
    } catch (e) {
      // 404: it ended on its own between the last poll and the click.
      if (httpStatus(e) !== 404) setStopErr(apiErrorText(e, 'could not stop it'))
    }
    setStopping(false)
    void qc.invalidateQueries({ queryKey: ['term', 'sessions'] })
    void qc.invalidateQueries({ queryKey: ['sessionList'] })
  }

  return (
    <>
      <div className="flex min-w-0 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3 py-1">
        <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: dot, boxShadow: `0 0 6px ${dot}` }} />
        <span className="min-w-0 flex-1 truncate text-[11px] uppercase tracking-[0.12em] text-[var(--color-accent)]" title={label}>
          {label}
        </span>
        {session?.dead && (
          <span className="shrink-0 text-[9px] uppercase tracking-[0.14em] text-[var(--color-danger)]">ended</span>
        )}
        <div className="flex shrink-0 items-center">
          {!gone && (
            <button type="button" onClick={() => navigate(termPath(name, back))} className={BTN_TEXT} title="Open it in the full-screen terminal">
              full screen
            </button>
          )}
          {!gone && (
            <button
              type="button"
              disabled={stopping}
              onClick={() => void stop()}
              title={stopArmed ? 'Click again to stop it' : 'Close this terminal. A Claude session ends on thor; the conversation stays resumable.'}
              className={`${BTN_TEXT} ${stopArmed ? 'text-[var(--color-danger)]' : 'hover:text-[var(--color-danger)]'}`}
            >
              {stopping ? 'stopping' : stopArmed ? 'stop?' : 'stop'}
            </button>
          )}
          <button type="button" onClick={term.deselect} className={BTN_TEXT} title="Close the pane. The session keeps running.">
            close
          </button>
        </div>
      </div>
      {stopErr && <div className="shrink-0 px-3 py-1.5 text-[11px] text-[var(--color-danger)]">{stopErr}</div>}
      {gone ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
          <div className="text-xs uppercase tracking-[0.2em] text-[var(--color-text-faint)]">this session ended</div>
          <div className="flex flex-wrap items-center justify-center gap-2">
            {resumable ? (
              <button
                type="button"
                disabled={term.busy}
                onClick={() => void term.resume(convo, titles.get(convo))}
                className={BTN_ACCENT}
              >
                <Play size={12} /> {term.busy ? 'opening' : 'resume'}
              </button>
            ) : (
              <button type="button" disabled={term.busy} onClick={() => void term.start()} className={BTN_ACCENT}>
                <Plus size={12} /> {term.busy ? 'opening' : 'new session'}
              </button>
            )}
            <button type="button" onClick={term.deselect} className={BTN_GHOST}>close</button>
          </div>
        </div>
      ) : (
        <Suspense fallback={LOADING}>
          <TermPane key={name} name={name} focused onConn={term.setConn} register={term.setApi} className="min-h-0 flex-1" />
        </Suspense>
      )}
    </>
  )
}

export function ProjectPage({ projectId }: { projectId: string }) {
  const [params, setParams] = useSearchParams()
  const paneRef = useRef<HTMLElement | null>(null)
  const [editing, setEditing] = useState(false)
  const [addingTab, setAddingTab] = useState(false)
  const [summaryOpen, setSummaryOpen] = useState(false)

  const doc = useQuery({
    queryKey: PROJ_KEYS.doc(projectId),
    queryFn: () => fetchProjDoc(projectId),
    staleTime: 5_000,
    refetchInterval: 60_000,
  })
  useProjectLive(projectId, doc.data?.project.rev)
  // Both are the board's own cache entries, shared with SessionBoard below.
  const board = useQuery({ queryKey: ['sessionList'], queryFn: fetchSessionList })
  const terms = useQuery({ queryKey: ['term', 'sessions'], queryFn: fetchTermSessions, refetchInterval: 15_000 })
  const term = useProjectTerm(projectId, doc.data?.project, paneRef)

  const rows = board.data?.installed ? board.data.sessions : NO_ROWS
  const titles = useMemo(() => {
    const m = new Map<string, string>()
    for (const s of rows) if (s.title) m.set(s.sessionId, s.title)
    return m
  }, [rows])
  // Every conversation the board knows, titled or not: proof one ever ran.
  const boardIds = useMemo(() => new Set(rows.map((r) => r.sessionId)), [rows])

  // The toast is for changes a session made while the page was open, so the
  // event the page loaded with only sets the baseline.
  const [seenEvent, setSeenEvent] = useState<number | null>(null)
  const [toast, setToast] = useState<ProjectEvent | null>(null)
  const hideToast = useCallback(() => setToast(null), [])
  const lastEvent = doc.data?.lastEvent ?? null
  if (doc.data && seenEvent === null) {
    setSeenEvent(lastEvent?.id ?? 0)
  } else if (lastEvent && seenEvent !== null && lastEvent.id > seenEvent) {
    setSeenEvent(lastEvent.id)
    if (lastEvent.actor.startsWith('session:')) setToast(lastEvent)
  }

  const d = doc.data
  if (!d) {
    if (!doc.isError) return LOADING
    return (
      <div className="panel mx-auto max-w-md p-6 text-center">
        <div className="text-sm text-[var(--color-danger)]">
          {httpStatus(doc.error) === 404 ? 'no such project' : apiErrorText(doc.error, 'project unavailable')}
        </div>
        <Link to="/projects" className="mt-3 inline-block text-xs uppercase tracking-[0.18em] text-[var(--color-text-dim)] hover:text-[var(--color-accent)]">
          &lt; all projects
        </Link>
      </div>
    )
  }

  const back = `/projects/${projectId}`
  const p = d.project
  const linkedIds = new Set(d.sessions.map((s) => s.sessionId))
  const linked = rows.filter((s) => linkedIds.has(s.sessionId))
  const liveCount = linked.filter((s) => s.live).length
  const askingRows = linked.filter((s) => s.activity === 'asking')
  const panes = (terms.data ?? NO_TERMS).filter((t) => !t.dead)
  const paneFor = new Map<string, string>()
  for (const t of panes) {
    const c = paneConversation(t)
    if (c) paneFor.set(c, t.name)
  }

  // Exactly one primary: the most useful next step, in order of how much it
  // costs Brendon to be without it.
  let primary: Primary
  const answering = askingRows.find((s) => paneFor.has(s.sessionId))
  // Opened for this project, or running one of its conversations: a session
  // resumed from the plain board and linked afterwards has no project on its
  // tmux session, and it is still the one Brendon is continuing.
  const own = panes
    .filter((t) => (t.projectId !== '' && t.projectId === projectId) || linkedIds.has(paneConversation(t)))
    .sort((a, b) => (b.activityAt || b.createdAt) - (a.activityAt || a.createdAt))[0]
  // Not a live one and not one in a pane: that is running in a window on thor
  // or in tmux (the board marks a pane live only once Claude registers), and
  // resuming it here would put a second Claude on the same transcript.
  const resumable = linked
    .filter((s) => !s.done && !s.live && !paneFor.has(s.sessionId) && activeWithin(s.lastActivityUtc, WEEK_MS))
    .sort((a, b) => (b.lastActivityUtc ?? '').localeCompare(a.lastActivityUtc ?? ''))[0]
  if (answering) {
    const pane = paneFor.get(answering.sessionId) ?? ''
    primary = { kind: 'answer', label: 'answer', run: () => term.open(pane) }
  } else if (own) {
    primary = { kind: 'continue', label: 'continue', run: () => term.open(own.name) }
  } else if (resumable) {
    primary = { kind: 'resume', label: `resume ${resumable.title}`, run: () => void term.resume(resumable.sessionId, resumable.title) }
  } else {
    primary = { kind: 'new', label: 'new session', run: () => void term.start() }
  }
  const PrimaryIcon = primary.kind === 'answer' ? MessageSquare : primary.kind === 'new' ? Plus : primary.kind === 'resume' ? Play : SquareTerminal

  const customTabs = [...d.tabs].sort((a, b) => a.sortOrder - b.sortOrder)
  const pending = d.reminders.filter((r) => r.state === 'pending').length
  // Sessions and files are the side columns now, not tabs.
  const tabs: { id: string; label: string; count?: number }[] = [
    ...customTabs.map((t) => ({ id: t.id, label: t.title })),
    { id: 'automations', label: 'agents', count: d.automations.length },
    { id: 'reminders', label: 'reminders', count: pending },
    { id: 'activity', label: 'activity' },
  ]
  const active = tabs.find((t) => t.id === params.get('tab')) ?? tabs[0]
  const custom = customTabs.find((t) => t.id === active.id) ?? null
  // Picking a tab also closes a session shown in the middle column.
  const setTab = (id: string) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (id === tabs[0].id) next.delete('tab')
      else next.set('tab', id)
      next.delete('term')
      return next
    }, { replace: true })
  }
  const tabProps: ProjectTabProps = { projectId, doc: d, term }

  // A session opened on a desktop takes the middle column; the tabs come back
  // when it is closed or a tab is picked.
  const showTerm = term.embedded && term.selected !== null

  return (
    <div className="mx-auto max-w-[1700px] space-y-4">
      <header className="space-y-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-faint)]">
          <Link to="/projects" className="transition hover:text-[var(--color-accent)]">projects</Link>
          <span>/</span>
          <span>{p.area}</span>
          {p.exposure === 'tailnet' && <span>· tailnet only</span>}
          {p.status !== 'active' && <span className="text-[var(--color-warning)]">· {p.status}</span>}
          <span className="ml-auto normal-case tracking-normal">
            {liveCount} live
            {askingRows.length > 0 && <span className="text-[var(--color-warning)]"> · {askingRows.length} asking</span>}
            {d.lastEvent && <> · changed {ago(d.lastEvent.at)} by {actorLabel(d.lastEvent.actor, titles)}</>}
          </span>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {/* Its own line on a phone, where the button beside it cut the name to a word. */}
          <h1 className="min-w-0 basis-full truncate text-lg font-semibold tracking-[0.04em] text-[var(--color-accent)] sm:basis-auto sm:flex-1" title={p.name}>
            {p.name}
          </h1>
          <button type="button" disabled={term.busy} onClick={primary.run} className={`${BTN_ACCENT} min-w-0 max-w-[16rem]`}>
            <PrimaryIcon size={12} className="shrink-0" />
            <span className="min-w-0 truncate">{term.busy ? 'opening' : primary.label}</span>
          </button>
          {primary.kind !== 'new' && (
            <button type="button" disabled={term.busy} onClick={() => void term.start()} className={ICON_BTN} title="New session in this project" aria-label="New session">
              <Plus size={15} />
            </button>
          )}
          <button type="button" onClick={() => setEditing(true)} className={ICON_BTN} title="Edit the project" aria-label="Edit the project">
            <Pencil size={13} />
          </button>
        </div>
        {p.nextAction && (
          <div className="break-words text-[13px] text-[var(--color-text)]">
            <span className="mr-2 text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-faint)]">next</span>{p.nextAction}
          </div>
        )}
        {p.summary && (
          <button
            type="button"
            onClick={() => setSummaryOpen((v) => !v)}
            title={summaryOpen ? 'Show less' : 'Show the whole summary'}
            className={`w-full text-left text-xs leading-relaxed text-[var(--color-text-dim)] transition hover:text-[var(--color-text)] ${summaryOpen ? '' : 'line-clamp-1'}`}
          >
            {p.summary}
          </button>
        )}
        {term.error && (
          <div className="flex items-start gap-2 border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 text-xs text-[var(--color-danger)]">
            <span className="min-w-0 flex-1 break-words">{term.error}</span>
            <button type="button" onClick={term.dismissError} aria-label="Dismiss" className="-m-1 shrink-0 p-1 hover:text-[var(--color-text)]">
              <X size={12} />
            </button>
          </div>
        )}
      </header>

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:gap-6">
        <SidePanel
          id="sessions"
          title="sessions"
          count={liveCount}
          icon={<SquareTerminal size={14} />}
          width="lg:w-72"
          actions={(
            <button
              type="button"
              disabled={term.busy}
              onClick={() => void term.start()}
              title="New session in this project"
              aria-label="New session"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center text-[var(--color-text-faint)] transition hover:text-[var(--color-accent)] disabled:opacity-40"
            >
              <Plus size={14} />
            </button>
          )}
        >
          <SessionsPanel
            projectId={projectId}
            doc={d}
            term={term}
            rows={rows}
            terms={terms.data ?? NO_TERMS}
            titles={titles}
          />
        </SidePanel>

        <main className="min-w-0 flex-1 space-y-4">
          <nav className="flex items-center gap-x-5 overflow-x-auto border-b border-[var(--color-border)] [scrollbar-width:none] sm:flex-wrap sm:overflow-visible [&::-webkit-scrollbar]:hidden">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`${TAB_CLS} ${!showTerm && active.id === t.id ? TAB_ON : TAB_OFF}`}
              >
                <span className="inline-block max-w-[12rem] truncate align-bottom">{t.label}</span>
                {t.count ? <span className="ml-1.5 text-[var(--color-text-faint)]">{t.count}</span> : null}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setAddingTab(true)}
              aria-label="Add a tab"
              title="Add a notes, checklist or links tab"
              className={`${TAB_CLS} ${TAB_OFF}`}
            >
              <Plus size={12} />
            </button>
          </nav>

          {showTerm && term.selected ? (
            <section
              ref={paneRef}
              className="flex h-[calc(100dvh-15rem)] min-h-[420px] flex-col border border-[var(--color-border)] bg-[var(--color-bg)]"
            >
              <SelectedTerm
                key={term.selected}
                name={term.selected}
                term={term}
                terms={terms.data ?? NO_TERMS}
                settled={terms.isFetched && !terms.isFetching}
                titles={titles}
                boardIds={boardIds}
                doc={d}
                back={back}
              />
            </section>
          ) : (
            <div className="min-w-0">
              {custom?.kind === 'markdown' && <MarkdownTab key={custom.id} {...tabProps} tab={custom} />}
              {custom?.kind === 'checklist' && <ChecklistTab key={custom.id} {...tabProps} tab={custom} />}
              {custom?.kind === 'links' && <LinksTab key={custom.id} {...tabProps} tab={custom} />}
              {active.id === 'automations' && <AutomationsTab {...tabProps} />}
              {active.id === 'reminders' && <RemindersTab {...tabProps} />}
              {active.id === 'activity' && <ActivityTab {...tabProps} />}
            </div>
          )}
        </main>

        <SidePanel
          id="files"
          title="files"
          count={d.files.length}
          icon={<FileText size={14} />}
          width="lg:w-80"
        >
          <FilesTab {...tabProps} compact />
        </SidePanel>
      </div>

      {editing && <ProjectEditSheet project={p} onClose={() => setEditing(false)} />}
      {addingTab && <AddTabSheet projectId={projectId} onClose={() => setAddingTab(false)} />}
      {toast && <Toast key={toast.id} projectId={projectId} event={toast} titles={titles} onClose={hideToast} />}
    </div>
  )
}
