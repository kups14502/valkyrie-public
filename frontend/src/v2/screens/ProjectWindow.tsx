import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import { StatusStrip, desktopWindow } from '../kit/shell'
import { DotFloor, Press, ToastHost, cx, toast } from '../kit/ui'
import { Icon, hostIcon, type IconName, type IconTone } from '../kit/icons'
import { ago, useHosts, useLaunchTargets, useSessionIndex, useSessions, useTick, type SessionVM } from '../kit/data'
import { applyPalette, useFont, useStoredMode } from '../kit/theme'
import { PROJECT_ID_RE, closeDetached, openDetached, setDetachedTitle } from '../kit/windows'
import {
  apiErrorText, fetchTermSessions, killTermSession, launchSessionOnHost, openTermSession, setSessionsDone, stopSessionOnHost,
  type TermSession,
} from '../../lib/api'
import {
  PROJ_KEYS, fetchProjDoc, unlinkProjSession, updateProj, type ChecklistItem, type Exposure, type ProjectDoc,
} from '../../lib/projectsApi'
import { safeHref } from '../../components/Markdown'
import {
  LinkSessionPicker, PIcon, ProjectNotes, ProjectReminders, ProjectSettings, ProjectTasks, SessionActions,
  type NoteTab, type ProjMeta, type ProjReminder, type ProjTask,
} from './ProjectPage'
import './claude.css'
import './projectwindow.css'

// A project in its own window (/m/w/project/<id>, opened by kit/windows.ts
// openDetached): the AI > Projects detail laid out for a whole window. The
// status strip is the frameless window's title bar; under it the project's
// name, then two columns: what to do next, the start button and the linked
// sessions on the left; tasks, reminders, notes, pinned files and agent runs
// on the right (one column in a narrow window). Every session this page opens
// or starts opens in a window of its own, so the project stays in view.
//
// The writes are the project detail's (Claude.tsx ProjectDetail): a project
// session always opens in the page's terminal, the only path that hands it the
// project's MCP server; stop, done and unlink act on one session at a time.

type Vars = CSSProperties & Record<`--${string}`, string | number>
const iv = (i: number): Vars => ({ '--i': i })

const HOME_HOST = 'thor'
const errText = (e: unknown) => apiErrorText(e, (e as Error | null)?.message || 'no reply')
const httpStatus = (e: unknown): number | null => (e as { response?: { status?: number } } | null)?.response?.status ?? null
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const areaName = (a: string) => (a ? a[0].toUpperCase() + a.slice(1) : 'Other')
const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
/** "2:00 AM" today, "Sun 9:00 AM" within a week, else "Oct 24 9:00 AM" (the project detail's format) */
const dayClock = (ms: number, now = Date.now()) => {
  const d = new Date(ms)
  if (d.toDateString() === new Date(now).toDateString()) return clock(ms)
  if (Math.abs(ms - now) < 6.5 * 86_400_000) return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${clock(ms)}`
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${clock(ms)}`
}
const shortDate = (ms: number) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'date unknown')

type Activity = SessionVM['activity']
const ACTIVITY_RANK: Record<Activity, number> = { asking: 0, working: 1, idle: 2, closed: 3 }
const STATE_WORD: Record<Activity, string> = { working: 'working', asking: 'asking', idle: 'idle', closed: 'open' }
// working and asking are lit (glow); idle is dim and closed faint, no glow
const STATE_ICON: Record<Activity, { name: IconName; tone: IconTone; glow: boolean }> = {
  working: { name: 'working', tone: 'fg', glow: true },
  asking: { name: 'asking', tone: 'acc2', glow: true },
  idle: { name: 'idle', tone: 'dim', glow: false },
  closed: { name: 'claude', tone: 'faint', glow: false },
}
const isLive = (s: Pick<SessionVM, 'live' | 'activity'>) => s.live || s.activity !== 'closed'

/** A board row with whether it is marked done (the board's index carries it; the persisted open rows are never done). */
type Row = SessionVM & { done: boolean }

// In-page terminals: the board's and the terminal page's cache entry.
const TERMS_KEY = ['term', 'sessions']
const paneFor = (terms: TermSession[] | undefined, id: string): string | null =>
  terms?.find((t) => !t.dead && (t.sessionId === id || (t.mode === 'resume' && t.target === id)))?.name ?? null

/** The pane list right before an open: a second resume of a conversation already in a pane is a second Claude on one transcript. */
async function freshPanes(qc: QueryClient): Promise<TermSession[]> {
  try {
    return await qc.fetchQuery({ queryKey: TERMS_KEY, queryFn: fetchTermSessions, staleTime: 5_000 })
  } catch {
    return qc.getQueryData<TermSession[]>(TERMS_KEY) ?? []
  }
}

/** The pop-out terminal's first grid (its default window size); the page fits the real one once it connects. */
const SESSION_GRID = { cols: 110, rows: 38 }

// What AI > Projects stored about sessions it has seen (Claude.tsx useSessionBriefs),
// read here so a linked session that left the board still has a name.
type Brief = { title: string; project: string; host: string; last: number }
function readBriefs(): Record<string, Brief> {
  try { return JSON.parse(localStorage.getItem('v2.claude.briefs') || '{}') as Record<string, Brief> } catch { return {} }
}

type Link = { id: string; host: string; note: string; at: number }

function StateIcon({ a, size = 16 }: { a: Activity; size?: number }) {
  const s = STATE_ICON[a]
  return <Icon name={s.name} size={size} tone={s.tone} glow={s.glow} />
}

/** /m/w/project/:id */
export default function ProjectWindow() {
  const { id = '' } = useParams()
  // no shell here: follow the stored scheme and font the way it does
  const stored = useStoredMode()
  useLayoutEffect(() => { applyPalette(stored) }, [stored])
  useFont()
  return <ProjectWin key={id} id={id} />
}

function ProjectWin({ id }: { id: string }) {
  const valid = PROJECT_ID_RE.test(id)
  const qc = useQueryClient()
  const navigate = useNavigate()
  const now = useTick(10_000)
  const doc = useQuery({
    queryKey: PROJ_KEYS.doc(id),
    queryFn: () => fetchProjDoc(id),
    enabled: valid,
    refetchInterval: () => (document.hidden ? false : 20_000),
    refetchOnWindowFocus: true,
    retry: (n, e) => httpStatus(e) !== 404 && n < 2,
  })
  const d = doc.data
  const p = d?.project
  const missing = !valid || httpStatus(doc.error) === 404

  useEffect(() => {
    setDetachedTitle(p ? `${p.name} · Valkyrie` : missing ? 'Valkyrie' : 'Project · Valkyrie')
  }, [p, missing])

  const win = desktopWindow()
  return (
    <div className="vpw" data-win={win || undefined}>
      <div className="vpw-backdrop" aria-hidden><DotFloor className="vl-floor-faint" /></div>
      <header className="vpw-head">
        <StatusStrip />
        <div className="vpw-bar" data-tauri-drag-region={win ? 'deep' : undefined}>
          <Icon name="projects" size={17} tone="fg" glow={!!p} />
          <h1 className="vpw-name vl-ellipsis">{p?.name ?? (missing ? 'Not a project' : 'Loading')}</h1>
          {p && <Caps doc={d} now={now} />}
          {p && (
            <Press
              className="vl-link vpw-full"
              title="Files, activity, agents and note editing, on the classic project page"
              onPress={() => navigate(`/projects/${encodeURIComponent(p.id)}`)}
            >
              <Icon name="enter" size={13} tone="dim" />Open full project
            </Press>
          )}
        </div>
        <div className="vl-nav-line vpw-line" />
      </header>

      <main className="vpw-body">
        {missing ? (
          <section className="vpw-gone vl-build-on">
            <p className="vl-build" style={iv(1)}>{valid ? `No project named ${id}. It was deleted, or the link is wrong.` : 'This window was given a project id that is not one.'}</p>
            <Press className="vc-glass vl-build" style={iv(2)} onPress={() => closeDetached('/m/ai/projects')}>
              <Icon name="stop" size={15} tone="fg" />Close window
            </Press>
          </section>
        ) : !d || !p ? (
          <p className="vpw-loading">
            {doc.isError
              ? <><Icon name="alert" size={14} tone="acc2" />The project did not answer: {errText(doc.error)}. Trying again.</>
              : <><Icon name="refresh" size={14} tone="dim" className="vl-pulse" />Reading the project</>}
          </p>
        ) : (
          <ProjectBody doc={d} now={now} onChanged={() => {
            void qc.invalidateQueries({ queryKey: PROJ_KEYS.doc(id) })
            void qc.invalidateQueries({ queryKey: PROJ_KEYS.list })
          }} />
        )}
      </main>
      <ToastHost className="vpw-toasts" />
    </div>
  )
}

function Caps({ doc, now }: { doc: ProjectDoc; now: number }) {
  const p = doc.project
  const open = doc.tabs.filter((t) => t.kind === 'checklist').flatMap((t) => t.items as ChecklistItem[]).filter((i) => !i.done).length
  const caps = [areaName(p.area)]
  if (p.status !== 'active') caps.push(p.status)
  caps.push(`updated ${ago(Date.parse(p.updatedAt), now)} ago`)
  if (open > 0) caps.push(`${open} open`)
  return (
    <span className="vc-pd-caps vpw-caps">
      {caps.map((c, n) => <span key={c}>{n > 0 && <b>·</b>}{c}</span>)}
    </span>
  )
}

function ProjectBody({ doc, now, onChanged }: { doc: ProjectDoc; now: number; onChanged: () => void }) {
  const p = doc.project
  const qc = useQueryClient()
  const targets = useLaunchTargets()
  const hosts = useHosts()
  const sessions = useSessions()
  const index = useSessionIndex()
  const panes = useQuery({ queryKey: TERMS_KEY, queryFn: fetchTermSessions, refetchInterval: 15_000 })
  const [editing, setEditing] = useState(false)
  const [more, setMore] = useState(false)
  const [exp, setExp] = useState<string | null>(null)
  const [linking, setLinking] = useState(false)
  const linkRef = useRef<HTMLInputElement>(null)
  const [doneOpen, setDoneOpen] = useState(false)
  const [allOpen, setAllOpen] = useState(false)
  // unlinked here, hidden until the doc stops listing them
  const [unlinked, setUnlinked] = useState<ReadonlySet<string>>(() => new Set())
  // 'start', 'restore' or the linked session being worked on; one at a time
  const [busy, setBusy] = useState<string | null>(null)
  const inFlight = useRef(false)
  // the last refusal, inline as well as a toast
  const [note, setNote] = useState<string | null>(null)
  // stops and done marks that landed, shown over the board for a minute (the board catches up within that)
  const [over, setOver] = useState<ReadonlyMap<string, { patch: Partial<Row>; at: number }>>(() => new Map())
  const [briefs] = useState(readBriefs)
  // the link picker's search takes the caret as it opens
  useEffect(() => { if (linking) linkRef.current?.focus({ preventScroll: true }) }, [linking])

  const hostLabel = useMemo(() => {
    const m = new Map((hosts.data ?? []).map((h) => [h.id, h.label]))
    return (h: string) => m.get(h) ?? h
  }, [hosts.data])

  // any session by id: the whole board once this window has fetched it, the persisted open rows before that
  const lookup = useMemo(() => {
    const open = new Map((sessions.data ?? []).map((s) => [s.id, s]))
    return (sid: string): Row | undefined => {
      const s: Row | undefined = index.byId.get(sid) ?? (open.has(sid) ? { ...open.get(sid)!, done: false } : undefined)
      const o = over.get(sid)
      return s && o && now - o.at < 60_000 ? { ...s, ...o.patch } : s
    }
  }, [sessions.data, index.byId, over, now])

  const say = (msg: string, ms = 5000) => {
    setNote(msg)
    toast(msg, { ms })
  }
  const run = async (what: string, fail: string, fn: () => Promise<void>) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(what)
    setNote(null)
    try {
      await fn()
    } catch (e) {
      // verbatim: the backend's 409 at the session cap says what to close
      say(`${fail}: ${errText(e)}`)
    } finally {
      inFlight.current = false
      setBusy(null)
    }
  }
  const refreshSessions = () => {
    void qc.invalidateQueries({ queryKey: ['v2', 'sessions'] })
    void qc.invalidateQueries({ queryKey: ['sessionList'] })
    void qc.invalidateQueries({ queryKey: TERMS_KEY })
  }
  const landed = (r: { name: string }, title: string | undefined) => {
    onChanged()
    void qc.invalidateQueries({ queryKey: TERMS_KEY })
    if (r.name) openDetached({ kind: 'session', name: r.name, title: title || p.name })
  }

  // no label: the backend names a project session after the project
  const start = () => run('start', `Could not start a session in ${p.name}`, async () => {
    landed(await openTermSession({ mode: 'new', project: p.id, ...SESSION_GRID }), p.name)
  })
  const restore = () => run('restore', `Could not restore ${p.name}`, async () => {
    await updateProj(p.id, { status: 'active' })
    onChanged()
    toast(`Restored ${p.name}`)
  })
  const resume = (sid: string, title: string | undefined, host: string) => run(sid, `Could not open "${title || 'the session'}"`, async () => {
    const pane = paneFor(await freshPanes(qc), sid)
    if (pane) {
      openDetached({ kind: 'session', name: pane, title })
      return
    }
    if (lookup(sid)?.live) {
      say(`"${title || 'The session'}" is running on ${hostLabel(host)}. Use Move here, or stop it, to open it here.`, 4000)
      return
    }
    // the in-page terminal reaches thor only; a transcript elsewhere opens on its own machine
    if (host !== HOME_HOST) {
      const r = await launchSessionOnHost(sid, '', host)
      if (!r.ok) throw new Error(r.detail ?? `${host} launcher unavailable (${r.status})`)
      toast(`Opened "${title || 'the session'}" on ${hostLabel(host)}`)
      return
    }
    landed(await openTermSession({ mode: 'resume', sessionId: sid, project: p.id, label: title, ...SESSION_GRID }), title)
  })
  // Running in a window on thor: stop it there, give its Claude a moment to
  // finish the transcript, then pick it up here. A 404 means it had exited.
  const move = (sid: string, title: string) => run(sid, `Could not move "${title}"`, async () => {
    try {
      const r = await stopSessionOnHost(sid, HOME_HOST)
      if (r && r.ok === false) throw new Error(r.detail ?? `${HOME_HOST} refused`)
    } catch (e) {
      if (httpStatus(e) !== 404) throw e
    }
    await sleep(1500)
    refreshSessions()
    landed(await openTermSession({ mode: 'resume', sessionId: sid, project: p.id, label: title, ...SESSION_GRID }), title)
  })
  const stopPane = (sid: string, pane: string, title: string) => run(sid, `Could not stop "${title}"`, async () => {
    try {
      await killTermSession(pane)
    } catch (e) {
      if (httpStatus(e) !== 404) throw e
    }
    setExp(null)
    refreshSessions()
    toast(`Stopped "${title}"`)
  })
  const stopRow = (s: Row, title: string) => run(s.id, `Could not stop "${title}"`, async () => {
    try {
      const r = await stopSessionOnHost(s.id, s.host)
      if (r && r.ok === false) throw new Error(r.detail ?? `${s.host} refused`)
      toast(`Stopped "${title}"`)
    } catch (e) {
      if (httpStatus(e) !== 404) throw e
      toast(`"${title}" was not running`)
    }
    setOver((m) => new Map(m).set(s.id, { patch: { activity: 'closed', live: false }, at: Date.now() }))
    setExp(null)
    refreshSessions()
  })
  const markDone = (s: Row, done: boolean, title: string) => run(s.id, `Could not ${done ? 'mark' : 'reopen'} "${title}"`, async () => {
    const r = await setSessionsDone([s.id], done, s.host)
    if (r && r.ok === false) throw new Error(r.detail ?? `${s.host} refused`)
    setOver((m) => new Map(m).set(s.id, { patch: { done }, at: Date.now() }))
    setExp(null)
    refreshSessions()
    toast(done ? `Done: "${title}"` : `"${title}" is back on the list`)
  })
  const unlink = (sid: string, title: string) => run(sid, `Could not unlink "${title}"`, async () => {
    await unlinkProjSession(p.id, sid)
    setUnlinked((s) => new Set(s).add(sid))
    setExp(null)
    onChanged()
    toast(`Unlinked "${title}" from ${p.name}`)
  })

  // ---- the doc, shaped ----
  const target = targets.data?.find((t) => t.key === p.targetKey)
  const lists = doc.tabs.filter((t) => t.kind === 'checklist')
  const tasks: ProjTask[] = lists.flatMap((t) => (t.items as ChecklistItem[]).map((it) => ({ id: it.id, tabId: t.id, text: it.text, done: it.done, due: it.due ?? null })))
  const reminders: ProjReminder[] = doc.reminders
    .filter((r) => r.state === 'pending')
    .map((r) => ({ id: r.id, at: Date.parse(r.at), message: r.message }))
    .sort((a, b) => a.at - b.at)
  const notes: NoteTab[] = doc.tabs
    .filter((t) => t.kind === 'markdown' || t.kind === 'links')
    .map((t) => ({ id: t.id, kind: t.kind === 'links' ? 'links' : 'markdown', title: t.title, n: t.items.length }))
  const meta: ProjMeta = {
    targetKey: p.targetKey,
    exposure: (p.exposure === 'anywhere' ? 'anywhere' : 'tailnet') as Exposure,
    allowSnapshots: p.allowSnapshots === true,
    sessionEdits: p.sessionEdits !== false,
  }
  const seen = new Set<string>()
  const allLinks: Link[] = doc.sessions
    .filter((l) => !seen.has(l.sessionId) && !!seen.add(l.sessionId))
    .map((l) => ({ id: l.sessionId, host: l.host, note: l.statusNote, at: Date.parse(l.statusAt ?? l.linkedAt) }))
  const links = allLinks.filter((l) => !unlinked.has(l.id))
  const linkedIds = new Set(allLinks.map((l) => l.id))

  // the board gives the real state; a stored brief only names it (its state is old)
  const info = (sid: string): { title: string; project: string; host: string; last: number; activity: Activity } | undefined => {
    const s = lookup(sid)
    if (s) return s
    const b = briefs[sid]
    return b ? { ...b, activity: 'closed' } : undefined
  }
  const rank = (sid: string) => ACTIVITY_RANK[info(sid)?.activity ?? 'closed']
  const sorted = [...links].sort((x, y) => rank(x.id) - rank(y.id) || (info(y.id)?.last || y.at) - (info(x.id)?.last || x.at))
  // a running session marked done stays with the open ones until it closes (the board's rule)
  const isDoneRow = (sid: string) => {
    const s = lookup(sid)
    return !!s && s.done && !isLive(s)
  }
  const openLinks = sorted.filter((l) => !isDoneRow(l.id))
  const doneLinks = sorted.filter((l) => isDoneRow(l.id))
  const openShown = allOpen ? openLinks : openLinks.slice(0, 12)
  const archived = p.status === 'archived'
  const longSummary = p.summary.length > 420
  const nextRem = reminders[0] ?? null
  const files = doc.files
  const runs = doc.runs.slice(0, 8)

  const sessionRow = (l: Link) => {
    const s = info(l.id)
    const row = lookup(l.id)
    const a = s?.activity ?? 'closed'
    const liveRow = a !== 'closed'
    const host = s?.host ?? l.host
    const title = s?.title || l.note || `Linked session · ${shortDate(l.at)}`
    const pane = paneFor(panes.data, l.id)
    const mine = busy === l.id
    const open = exp === l.id
    const done = !!row?.done
    const word = mine ? 'working on it' : liveRow ? STATE_WORD[a] : done ? 'done' : ''
    return (
      <div key={l.id} className="vp-sitem" data-exp={open || undefined} data-done={(done && !liveRow) || undefined}>
        <div className="vp-sline">
          <Press
            className="vc-pd-srow"
            data-busy={mine || undefined}
            disabled={busy !== null}
            title={pane ? 'Bring up the window already running this session' : host !== HOME_HOST ? `Open a terminal on ${hostLabel(host)}, where this session lives` : `Open it in its own window, running on ${hostLabel(host)}`}
            onPress={() => void resume(l.id, s?.title || undefined, host)}
          >
            <StateIcon a={a} />
            <span className="vc-row-main">
              <span className="vc-row-title" data-closed={!liveRow || undefined}>{title}</span>
              <span className="vc-row-sub">
                <Icon name={hostIcon(host)} size={12} tone={liveRow ? 'dim' : 'faint'} title={hostLabel(host)} />
                <span>{[s?.project, host !== HOME_HOST ? hostLabel(host) : '', pane ? 'in a pane' : row?.live ? 'in a window' : ''].filter(Boolean).join(' · ') || 'not on the open board'}</span>
              </span>
            </span>
            <span className="vc-row-meta">
              <span className="vc-ago" data-a={a}>{ago(s?.last || l.at, now)}</span>
              {word && <span className="vc-state" data-a={liveRow && !mine ? a : 'closed'}>{word}</span>}
            </span>
          </Press>
          <Press
            className="vp-more"
            aria-label={`Actions for ${title}`}
            aria-expanded={open}
            title="Stop, done, unlink"
            onPress={() => setExp((e) => (e === l.id ? null : l.id))}
          >
            <PIcon name="more" size={16} tone={open ? 'fg' : 'dim'} />
          </Press>
        </div>
        {open && (
          <SessionActions
            canMove={!!row?.live && !pane && host === HOME_HOST}
            canStop={!!pane || (!!row && isLive(row))}
            canDone={!!row}
            done={done}
            busy={busy !== null}
            onMove={() => void move(l.id, title)}
            onStop={() => {
              if (pane) void stopPane(l.id, pane, title)
              else if (row) void stopRow(row, title)
            }}
            onDone={() => { if (row) void markDone(row, !row.done, title) }}
            onUnlink={() => void unlink(l.id, title)}
          />
        )}
      </div>
    )
  }

  let k = 1
  const left = (
    <div className="vpw-col vpw-main">
      {editing ? (
        <div className="vl-build" style={iv(k++)}>
          <ProjectSettings
            p={p}
            meta={meta}
            onClose={() => setEditing(false)}
            onSaved={onChanged}
            onArchived={() => setEditing(false)}
          />
        </div>
      ) : (
        <div className="vc-pd-next vl-build" style={iv(k++)}>
          <span className="vc-pd-label">Next</span>
          <p>{p.nextAction || 'No next action set'}</p>
        </div>
      )}

      <div className="vc-pd-actions vpw-actions vl-build" style={iv(k++)}>
        {archived ? (
          <Press className="vc-glass vc-pd-start" data-busy={busy === 'restore' || undefined} disabled={busy !== null} title="Put it back on the project list" onPress={() => void restore()}>
            {busy === 'restore' ? <Icon name="refresh" size={16} tone="fg" className="vl-pulse" /> : <PIcon name="restore" size={16} tone="fg" />}
            <span>{busy === 'restore' ? 'Restoring' : 'Restore project'}</span>
          </Press>
        ) : (
          <Press className="vc-glass vc-pd-start" data-busy={busy === 'start' || undefined} disabled={busy !== null} title={`Start an AI session in ${target?.label ?? p.name}, in its own window`} onPress={() => void start()}>
            <Icon name={busy === 'start' ? 'refresh' : 'start'} size={16} tone="fg" className={busy === 'start' ? 'vl-pulse' : undefined} />
            <span>{busy === 'start' ? 'Starting' : `Start session${target ? ` in ${target.label}` : ''}`}</span>
          </Press>
        )}
        {!editing && (
          <Press className="vl-link" title="Name, next action, summary, status, area, folder, exposure, archive" onPress={() => setEditing(true)}>
            <Icon name="settings" size={13} tone="dim" />Edit
          </Press>
        )}
      </div>
      {note && <p className="vc-act-err" role="alert"><Icon name="alert" size={13} tone="acc2" />{note}</p>}

      {nextRem && (
        <div className="vc-pd-rem vl-build" style={iv(k++)}>
          <span className="vc-pd-label"><Icon name="timer" size={12} tone="hot" />Reminder</span>
          <span className="vc-pd-rem-at">{dayClock(nextRem.at, now)}</span>
          <span className="vc-pd-rem-msg">{nextRem.message}</span>
        </div>
      )}

      {p.summary && !editing && (
        <div className="vc-pd-sumwrap vl-build" style={iv(k++)}>
          <p className="vc-pd-summary vpw-summary" data-clamp={(longSummary && !more) || undefined}>{p.summary}</p>
          {longSummary && <Press className="vc-more" onPress={() => setMore((m) => !m)}>{more ? 'Less' : 'More'}</Press>}
        </div>
      )}

      <section className="vc-pd-sec vl-build" style={iv(k)}>
        <header className="vc-ghead">
          <span className="vc-ghead-l">
            <Icon name="claude" size={14} tone="dim" />
            <span className="vc-ghead-t">Sessions</span>
            <span className="vc-ghead-n">{links.length}</span>
          </span>
          {!linking && (
            <Press className="vc-ghead-act" title="Add a session that started somewhere else" onPress={() => setLinking(true)}>
              <PIcon name="link" size={13} />Link a session
            </Press>
          )}
        </header>
        {linking && (
          <LinkSessionPicker
            projectId={p.id}
            area={p.area}
            linked={linkedIds}
            inputRef={linkRef}
            onClose={() => setLinking(false)}
            onLinked={onChanged}
          />
        )}
        {links.length ? (
          <div className="vc-rows">
            {openShown.map(sessionRow)}
            {openLinks.length > openShown.length && (
              <Press className="vc-showmore" onPress={() => setAllOpen(true)}>
                <Icon name="go" size={13} tone="dim" />Show {openLinks.length - openShown.length} more
              </Press>
            )}
            {doneLinks.length > 0 && (
              <Press className="vc-showmore" aria-expanded={doneOpen} onPress={() => setDoneOpen((v) => !v)}>
                <Icon name="done" size={13} tone="dim" />{doneOpen ? 'Hide done' : `Show ${doneLinks.length} done`}
              </Press>
            )}
            {doneOpen && doneLinks.map(sessionRow)}
          </div>
        ) : (
          <p className="vc-pd-none">No linked sessions. Start one above, or link one that began somewhere else.</p>
        )}
      </section>
    </div>
  )

  let r = 2
  const right = (
    <div className="vpw-col vpw-side">
      <ProjectTasks key={`t.${p.id}`} projectId={p.id} tasks={tasks} listTab={lists[0]?.id ?? null} k={r++} onChanged={onChanged} />
      <ProjectReminders key={`r.${p.id}`} projectId={p.id} list={reminders} now={now} k={r++} onChanged={onChanged} />
      {notes.length > 0 && (
        <div className="vl-build" style={iv(r++)}>
          <ProjectNotes key={`n.${p.id}`} projectId={p.id} tabs={notes} />
        </div>
      )}
      {files.length > 0 && (
        <section className="vc-pd-sec vl-build" style={iv(r++)}>
          <header className="vc-ghead">
            <span className="vc-ghead-l">
              <PIcon name="note" />
              <span className="vc-ghead-t">Pinned files</span>
              <span className="vc-ghead-n">{files.length}</span>
            </span>
          </header>
          <ul className="vpw-list">
            {files.map((f) => {
              const href = f.url ? safeHref(f.url) : null
              const where = f.relPath ?? f.url ?? (f.kind === 'doc' ? 'kept here' : '')
              return (
                <li key={f.id} title={f.note || undefined}>
                  <PIcon name={f.kind === 'url' ? 'link' : 'note'} size={13} tone="dim" />
                  <span className="vpw-list-main">
                    {href ? <a href={href} target="_blank" rel="noopener noreferrer">{f.label}</a> : <b>{f.label}</b>}
                    {where && <small className="vl-ellipsis">{where}</small>}
                  </span>
                </li>
              )
            })}
          </ul>
        </section>
      )}
      {runs.length > 0 && (
        <section className="vc-pd-sec vl-build" style={iv(r)}>
          <header className="vc-ghead">
            <span className="vc-ghead-l">
              <Icon name="service" size={14} tone="dim" />
              <span className="vc-ghead-t">Agent runs</span>
              <span className="vc-ghead-n">{doc.runs.length}</span>
            </span>
          </header>
          <ul className="vpw-list">
            {runs.map((x) => {
              const lit = x.status === 'running' || x.status === 'starting'
              const bad = x.status === 'failed' || x.status === 'blocked'
              return (
                <li key={x.id} title={x.summary || undefined}>
                  <Icon name={lit ? 'working' : bad ? 'alert' : 'done'} size={13} tone={lit ? 'fg' : bad ? 'acc2' : 'dim'} glow={lit} />
                  <span className="vpw-list-main">
                    <b className="vl-ellipsis">{x.name}</b>
                    {x.summary && <small className="vl-ellipsis">{x.summary}</small>}
                  </span>
                  <span className={cx('vpw-list-meta', lit && 'vpw-lit', bad && 'vpw-bad')}>{x.status} · {ago(Date.parse(x.startedAt), now)}</span>
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </div>
  )

  return (
    <div className="vpw-grid vl-build-on">
      {left}
      {right}
    </div>
  )
}
