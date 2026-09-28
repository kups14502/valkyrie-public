import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueries, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, Copy, Play, Plus, RotateCcw, Square, SquareTerminal, Undo2, X } from 'lucide-react'
import {
  fetchLaunchTargets, fetchSessionHosts, fetchSessionList, fetchTermSessions, killTermSession,
  launchSessionOnHost, localHostname, openNewSessionHere, openSessionHere, openTermSession,
  setSessionDone, setSessionsDone, startSessionOnHost, stopSessionOnHost, termLabel, termPath,
  type SessionActivity, type SessionHost, type TermSession, type WorkSession,
} from '../lib/api'
import { isTauri, isTauriMobile } from '../lib/auth'

// I open sessions on thor and recover them from anywhere. That is the whole
// feature, so this is one row per session and one button to get back into it.
//
// It replaces a "thread" view that grouped sessions by folder. Grouping existed
// to tame 455 rows, but 92% of those were the Obsidian hook's summariser runs
// (2894 of 3159 transcripts). Filtered out, only 265 are real and 14 were
// touched in the last day, so there was never anything for grouping to solve.
// Worse, a folder had to guess which session it meant and guessed wrong,
// resuming a hook run and presenting its own JSON prompt as the conversation.
// A row that IS a session cannot guess.

const HOST = 'thor'
const HOST_IP = '100.118.7.57'
const SHOWN_BY_DEFAULT = 20

// Where "open" puts a session. In a browser there is only one answer: the page.
// The desktop app can do either, and until now it could ONLY open a window on
// the local screen, so an in-page terminal was reachable from the desktop app
// only when one already existed and could be clicked in the "in page" row.
type OpenMode = 'page' | 'screen'
const OPEN_MODE_KEY = 'valkyrie-session-open-mode'

const readOpenMode = (): OpenMode => {
  // The Android app has no local terminal to open either.
  if (!isTauri() || isTauriMobile()) return 'page'
  try {
    return localStorage.getItem(OPEN_MODE_KEY) === 'page' ? 'page' : 'screen'
  } catch {
    return 'screen'
  }
}

// Work and personal do not belong in one interleaved list. thor routes every
// session to an area out of the same table the Obsidian capture uses, so this
// only has to order and name them. An area outside these three comes from the
// host's own config and is shown by its own name, right after work.
const AREA_ORDER = ['work', 'server', 'personal']
const AREA_LABEL: Record<string, string> = {
  work: 'work',
  server: 'server',
  personal: 'personal',
}

function groupByArea(rows: WorkSession[]): { area: string; rows: WorkSession[] }[] {
  const buckets = new Map<string, WorkSession[]>()
  for (const s of rows) {
    const key = s.area || 'other'
    const held = buckets.get(key)
    if (held) held.push(s)
    else buckets.set(key, [s])
  }
  const known = AREA_ORDER.filter((a) => buckets.has(a))
  const extra = [...buckets.keys()].filter((a) => !AREA_ORDER.includes(a) && a !== 'other').sort()
  const at = known[0] === 'work' ? 1 : 0
  const ordered = [...known.slice(0, at), ...extra, ...known.slice(at)]
  if (buckets.has('other')) ordered.push('other')
  return ordered.map((area) => ({ area, rows: buckets.get(area) ?? [] }))
}

const TONE: Record<SessionActivity, string> = {
  working: 'var(--color-accent)',
  asking: 'var(--color-warning)',
  idle: 'var(--color-success)',
  closed: 'var(--color-border)',
}
const WORD: Record<SessionActivity, string> = {
  working: 'working',
  asking: 'waiting on you',
  idle: 'open, idle',
  closed: '',
}

const relAge = (iso: string | null): string => {
  if (!iso) return ''
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const m = Math.round(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

const httpStatus = (e: unknown): number | null =>
  (e as { response?: { status?: number } } | null)?.response?.status ?? null

const fmtSize = (b: number): string =>
  b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`

function Row({ s, remote, here, inPage, attachedTo, picked, onPick, onOpen, onStop, onDone, onReattach, opening, stopping, busy }: {
  s: WorkSession
  remote: boolean
  here: string | null
  inPage: boolean
  // The in-page terminal already running this conversation, if there is one.
  attachedTo: string | null
  picked: boolean
  onPick: (s: WorkSession, next: boolean) => void
  onOpen: (s: WorkSession) => void
  onStop: (s: WorkSession) => void
  onDone: (s: WorkSession) => void
  onReattach: (terminal: string) => void
  opening: boolean
  stopping: boolean
  busy: boolean
}) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    if (!s.resumeCommand) return
    try {
      await navigator.clipboard.writeText(s.resumeCommand)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard blocked */ }
  }

  return (
    <div className={`group flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--color-border)] py-2.5 last:border-b-0${picked ? ' bg-[rgba(var(--color-accent-rgb),0.06)]' : ''}`}>
      {/* The status dot IS the checkbox. A square box next to a round dot was
          two controls where the row has room for one, and the dot already
          sits where the eye goes: dark when the session is closed, lit in its
          own colour while it is open, ringed once it is picked. Marking a
          finished morning done is then one click per row and one call for the
          lot. */}
      <button
        type="button"
        role="checkbox"
        aria-checked={picked}
        aria-label={`Pick ${s.title}`}
        onClick={() => onPick(s, !picked)}
        title={`${WORD[s.activity] || 'not running'} · click to pick it`}
        // The padding is the hit area and the negative margin hands it back to
        // the layout, so a 16px ring is a 36px target and nothing on the row
        // moves. A dot you have to aim at is a dot you stop using.
        className="-m-2.5 flex shrink-0 items-center justify-center p-2.5"
      >
        <span
          className={`flex h-4 w-4 items-center justify-center rounded-full border transition ${
            picked ? 'border-[var(--color-accent)]' : 'border-transparent group-hover:border-[var(--color-border-strong)]'
          }`}
        >
          <span
            aria-hidden
            className={`h-2 w-2 rounded-full${s.activity === 'working' ? ' animate-pulse' : ''}`}
            style={{ background: TONE[s.activity] }}
          />
        </span>
      </button>

      {/* The title gets the whole first line on a phone. Four buttons on the
          same line as it left about twenty readable characters, which for a
          list whose entire job is telling one conversation from another is no
          list at all: the basis pushes them onto their own line below, and at
          sm and up the original single row comes back. */}
      <div className="min-w-0 flex-1 basis-[calc(100%-1.75rem)] sm:basis-auto">
        <div
          className={`text-sm ${s.done ? 'text-[var(--color-text-faint)] line-through' : 'text-[var(--color-text)]'} line-clamp-2 sm:truncate`}
          title={s.cwd ?? undefined}
        >
          {s.title}
        </div>
        <div className="mt-0.5 truncate text-[11px] text-[var(--color-text-faint)]">
          {s.host !== HOST && <span className="text-[var(--color-text-dim)]">{s.host} · </span>}
          {s.project} · {relAge(s.lastActivityUtc)} · {fmtSize(s.bytes)}
          {s.activity !== 'closed' && (
            <span style={{ color: TONE[s.activity] }}> · {WORD[s.activity]}</span>
          )}
        </div>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1">
        {/* Running in a terminal on this page: just go to it. Stopping a
            session to reopen it is what the old row forced, because a live row
            offered nothing but stop. tmux is built for exactly this, so the
            session never needed to end. */}
        {attachedTo && (
          <button
            type="button"
            onClick={() => onReattach(attachedTo)}
            title="Go to the terminal already running this session"
            className="inline-flex min-h-9 items-center gap-1.5 border border-[var(--color-accent)]/60 bg-[rgba(var(--color-accent-rgb),0.10)] px-2.5 text-[10px] uppercase tracking-[0.1em] text-[var(--color-accent)] transition hover:border-[var(--color-accent)]"
          >
            <SquareTerminal size={11} /> reattach
          </button>
        )}
        {!s.done && !s.live && (
          <button
            type="button"
            disabled={opening || busy}
            onClick={() => onOpen(s)}
            title={inPage && s.host === HOST
              ? `Open it here in the page, running on ${HOST}`
              : s.host !== HOST ? `Open a terminal on ${s.host}, where this session lives`
              : remote ? `Open a terminal here on ${here}, resuming over SSH to ${HOST}` : `Open a terminal on ${HOST}`}
            className="inline-flex min-h-9 items-center gap-1.5 border border-[var(--color-border)] px-2.5 text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-dim)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-30"
          >
            <Play size={11} /> {opening ? 'opening' : 'open'}
          </button>
        )}
        {s.live && (
          <button
            type="button"
            disabled={stopping || busy}
            onClick={() => onStop(s)}
            title={s.bytes === 0
              ? `Stop it on ${s.host}. Nothing has been said in this one yet, so there is no transcript to reopen: stopping discards it.`
              : `Stop it on ${s.host}. The transcript is kept, so it reopens there whenever you want it.`}
            className="inline-flex min-h-9 items-center gap-1.5 border border-transparent px-2 text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-faint)] transition hover:text-[var(--color-danger)] disabled:opacity-30"
          >
            <Square size={11} /> {stopping ? 'stopping' : 'stop'}
          </button>
        )}
        <button
          type="button"
          onClick={copy}
          title={s.resumeCommand ?? 'no resume command'}
          disabled={!s.resumeCommand}
          className="inline-flex min-h-9 items-center border border-transparent px-2 text-[var(--color-text-faint)] transition hover:text-[var(--color-accent)] disabled:opacity-20"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onDone(s)}
          title={s.done ? 'Put it back on the list' : 'Finished with this one. Hides it.'}
          className="inline-flex min-h-9 items-center gap-1.5 border border-transparent px-2 text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-faint)] transition hover:text-[var(--color-accent)] disabled:opacity-30"
        >
          {s.done ? <><Undo2 size={12} /> undo</> : <><Check size={12} /> done</>}
        </button>
      </div>
    </div>
  )
}

// Start a session without remoting in first. The target list comes from the
// host itself and the click sends back only a key, so the page never names a
// directory.
//
// The menu is grouped by machine because it has to be: it used to say "new
// session" and always mean thor, so pressing it while sitting at mimir started
// the session on the wrong machine with nothing on screen admitting it. A host
// with no agent is listed with the reason rather than hidden.
//
// In-page mode offers only the targets the host flagged for the phone
// (personal and work); on its own screen the full list applies.
//
// "On screen" means THE SCREEN IN FRONT OF BRENDON, which is not always the
// host's. Starting a session posted to the host's own launcher agent, and that
// agent opens the tab where it runs: pressed at mimir, the session appeared in
// the list and the window appeared on thor. Resume has had a local path since
// the desktop app existed (openSessionHere); this is the same hop for a target
// key, so the machine the board is running on opens the terminal itself.
function NewSession({ onStarted, inPage, remote }: { onStarted: () => void; inPage: boolean; remote: boolean }) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const hosts = useQuery({ queryKey: ['sessionHosts'], queryFn: fetchSessionHosts, staleTime: 60_000 })
  const hostList = hosts.data ?? []
  const launchable = hostList.filter((h) => h.canLaunch)

  // One query per host, keyed and shaped exactly like the terminal page's, so
  // the cache entry is shared for real. A single query holding a Map used to
  // key on the joined host list, which with thor alone was the string 'thor':
  // the same key the terminal page reads as an array. Whichever page loaded
  // first won, and the other crashed on the shape it did not expect.
  const targetQueries = useQueries({
    queries: launchable.map((h) => ({
      queryKey: ['launchTargets', h.host],
      queryFn: () => fetchLaunchTargets(h.host),
      staleTime: 60_000,
    })),
  })
  const targetsByHost = new Map(launchable.map((h, i) => [h.host, targetQueries[i]?.data ?? []]))
  const targetsLoading = targetQueries.some((q) => q.isLoading)

  // Click-away, so the menu does not sit open over the list.
  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [open])

  if (hostList.length === 0) return null

  // In-page means the tmux pane on odin, which SSHes into thor and nowhere
  // else, so a host that cannot host one opens on its own screen instead.
  const opensInPage = (h: SessionHost) => inPage && h.canPage
  // Opened by this machine rather than by the host: only thor can be reached
  // over SSH from here, and only when the board is not already sitting on it.
  const opensHere = (h: SessionHost) => !opensInPage(h) && remote && h.host === HOST

  const start = async (h: SessionHost, key: string, label: string, group: string | null) => {
    setBusy(`${h.host}:${key}`); setErr(null)
    try {
      if (opensInPage(h)) {
        const r = await openTermSession({ mode: 'new', target: key, label })
        seedTerminal(qc, r)
        navigate(termPath(r.name))
        return
      }
      if (opensHere(h)) {
        // The group has to come from the host: the window is created here,
        // before any SSH runs, so nothing local knows which one this belongs in.
        await openNewSessionHere(key, HOST_IP, group)
        setTimeout(onStarted, 2_500)
        return
      }
      const r = await startSessionOnHost(h.host, key)
      if (!r.ok) setErr(r.detail ?? 'could not start it')
      // Claude takes a moment to register, so give the list something to find.
      setTimeout(onStarted, 2_500)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(null); setOpen(false)
    }
  }

  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => setOpen((v) => !v)}
        title="Start a new Claude session. The menu names the machine it starts on."
        className="inline-flex min-h-9 items-center gap-1.5 border border-[var(--color-border-strong)] px-3 text-[11px] text-[var(--color-text)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-40"
      >
        <Plus size={12} /> {busy ? `starting ${busy.split(':')[1]} on ${busy.split(':')[0]}…` : 'new session'} <ChevronDown size={11} />
      </button>

      {open && (
        <div className="absolute right-0 z-20 mt-1 min-w-56 border border-[var(--color-border-strong)] bg-[var(--color-surface)] py-1 shadow-lg">
          {hostList.map((h) => {
            const list = (targetsByHost.get(h.host) ?? []).filter((t) => t.exists && (!opensInPage(h) || t.phone))
            return (
              <div key={h.host} className="border-b border-[var(--color-border)]/50 py-1 last:border-b-0">
                <div className="flex items-baseline justify-between gap-2 px-3 py-1">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text)]">{h.host}</span>
                  <span className="text-[9px] uppercase tracking-[0.12em] text-[var(--color-text-faint)]">
                    {h.canLaunch
                      ? opensInPage(h) ? 'in the page' : opensHere(h) ? 'on this screen' : 'on its screen'
                      : 'unavailable'}
                  </span>
                </div>
                {h.canLaunch ? (
                  list.length > 0 ? list.map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => void start(h, t.key, t.label, t.group)}
                      className="block w-full px-3 py-2 text-left text-[11px] text-[var(--color-text-dim)] transition hover:bg-[rgba(var(--color-accent-rgb),0.1)] hover:text-[var(--color-accent)]"
                    >
                      {t.label}
                    </button>
                  )) : (
                    <div className="px-3 py-1.5 text-[10px] text-[var(--color-text-faint)]">
                      {targetsLoading ? 'reading targets…' : 'no targets'}
                    </div>
                  )
                ) : (
                  <div className="px-3 py-1.5 text-[10px] text-[var(--color-warning)]">
                    {h.detail ?? 'no launcher agent'}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      {err && <div className="absolute right-0 mt-1 text-[11px] text-[var(--color-danger)]">{err}</div>}
    </div>
  )
}

// Put the session we just created into the terminal page's cache BEFORE
// navigating to it.
//
// Without this the handoff picks the wrong session. OpenTerminals below keeps
// ['term','sessions'] warm, so the terminal page mounts, renders that cached
// list synchronously (and, inside the 10s global staleTime, may not refetch at
// all), fails to find the brand-new name from ?s= in it, and falls back to the
// old list's first row: the phone ends up attached to the previous session
// while the one just launched sits unselected. POST /terminal/sessions already
// returns the row, so seeding is exact; if it somehow came back without one,
// invalidating makes the page refetch and its own guard covers the gap.
function seedTerminal(qc: QueryClient, r: { name: string; session: TermSession | null }): void {
  if (!r.session) {
    void qc.invalidateQueries({ queryKey: ['term', 'sessions'] })
    return
  }
  const fresh = r.session
  qc.setQueryData<TermSession[]>(['term', 'sessions'], (old) => [fresh, ...(old ?? []).filter((s) => s.name !== fresh.name)])
}

// Terminals already open in the page: tmux sessions on odin, each an SSH client
// running Claude (or a shell) on thor. A tap reattaches; the X closes it, which
// ends the Claude process on thor and leaves the conversation resumable. Hidden
// when there are none, so a desk with no phone terminals never sees the row.
//
// `titles` maps a conversation id to what the board calls it, so a chip says
// what the session is about rather than what it was opened with. The label
// stored on the tmux session is fixed at creation: a terminal started on the
// personal target read "personal" for its whole life, and only closing and
// reopening it (as a resume, which passes the row's title) ever picked the real
// one up.
function OpenTerminals({ titles }: { titles: Map<string, string> }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [killing, setKilling] = useState<string | null>(null)
  const [all, setAll] = useState(false)
  const q = useQuery({ queryKey: ['term', 'sessions'], queryFn: fetchTermSessions, refetchInterval: 15_000 })
  // Oldest first, not the server's last-activity order: a terminal that printed
  // a line should not jump to the front of a list Brendon is about to tap.
  const list = [...(q.data ?? [])].sort((a, b) => a.createdAt - b.createdAt)
  if (list.length === 0) return null

  // A chip is a whole phone width once it carries a real title (measured: 281px
  // of a 317px row), so on a narrow screen these wrap into one per line. Four
  // is where the list stops being a header and starts being the page, hence the
  // fold rather than a scroller: a sideways drag on a 36px bar is the thing
  // this row is being fixed for.
  const shown = all ? list : list.slice(0, 4)
  const hidden = list.length - shown.length

  const kill = async (s: TermSession) => {
    setKilling(s.name)
    try { await killTermSession(s.name) } catch { /* the refresh below shows whether it went */ }
    setKilling(null)
    void qc.invalidateQueries({ queryKey: ['term', 'sessions'] })
    void qc.invalidateQueries({ queryKey: ['sessionList'] })
  }

  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] pb-2">
      <span className="shrink-0 text-[10px] uppercase tracking-[0.16em] text-[var(--color-text-faint)]">in page</span>
      {shown.map((s) => {
        const label = termLabel(s, titles)
        return (
          <div
            key={s.name}
            className={`flex w-full min-w-0 items-center border sm:w-auto sm:max-w-[20rem] ${s.dead ? 'border-[var(--color-danger)]/50' : 'border-[var(--color-border)]'}`}
          >
            <button
              type="button"
              onClick={() => navigate(termPath(s.name))}
              title={`Reattach to ${label} on ${s.host}`}
              className="flex min-h-9 min-w-0 flex-1 items-center gap-1.5 px-2.5 text-[11px] text-[var(--color-text-dim)] transition hover:text-[var(--color-accent)]"
            >
              <SquareTerminal size={11} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{label}</span>
              <span className={`shrink-0 text-[9px] uppercase tracking-[0.14em] ${s.dead ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-faint)]'}`}>
                {s.dead ? 'ended' : s.mode === 'shell' ? 'sh' : 'claude'}
                {s.activityAt > 0 ? ` · ${relAge(new Date(s.activityAt).toISOString())}` : ''}
              </span>
            </button>
            <button
              type="button"
              disabled={killing === s.name}
              onClick={() => void kill(s)}
              aria-label={`Close ${label}`}
              title="Close this terminal. A Claude session ends on thor; the conversation stays resumable."
              className="min-h-9 shrink-0 border-l border-[var(--color-border)] px-2.5 text-[var(--color-text-faint)] transition hover:text-[var(--color-danger)] disabled:opacity-30"
            >
              <X size={11} />
            </button>
          </div>
        )
      })}
      {(hidden > 0 || all) && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="min-h-9 shrink-0 px-2 text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-faint)] transition hover:text-[var(--color-accent)]"
        >
          {hidden > 0 ? `+${hidden} more` : 'show fewer'}
        </button>
      )}
    </div>
  )
}

// Recover the desk, or just one half of it. The single button reopened work and
// personal together, which is the wrong move at 9am on a Monday and the wrong
// move on a Saturday: the split button keeps the whole desk one click away and
// puts each area behind the chevron. The chevron only appears when the desk
// actually spans more than one area, since a menu repeating the button is noise.
function RecoverDesk({ desk, disabled, recovering, done, total, onRecover }: {
  desk: WorkSession[]
  disabled: boolean
  recovering: boolean
  done: number
  total: number
  onRecover: (rows: WorkSession[]) => void
}) {
  const [open, setOpen] = useState(false)
  const areas = groupByArea(desk)
  const split = areas.length > 1

  // Click-away, so the menu does not sit open over the list.
  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [open])

  return (
    <div className="relative flex items-stretch" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onRecover(desk)}
        title={`Reopen the ${desk.length} session(s) still open and not running. Marking one done is what takes it off this list.`}
        className={`inline-flex min-h-9 items-center gap-2 border border-[var(--color-accent)] px-3 text-[11px] text-[var(--color-accent)] transition hover:bg-[var(--color-accent)]/10 disabled:opacity-40${split ? ' border-r-0' : ''}`}
      >
        <RotateCcw size={12} /> {recovering ? `recovering ${done}/${total}…` : `recover my desk (${desk.length})`}
      </button>
      {split && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
          aria-label="Recover one area instead of the whole desk"
          title="Recover one area instead of the whole desk"
          className="inline-flex min-h-9 items-center border border-[var(--color-accent)] px-1.5 text-[var(--color-accent)] transition hover:bg-[var(--color-accent)]/10 disabled:opacity-40"
        >
          <ChevronDown size={12} />
        </button>
      )}

      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 min-w-44 border border-[var(--color-border-strong)] bg-[var(--color-surface)] py-1 shadow-lg">
          {areas.map((g) => (
            <button
              key={g.area}
              type="button"
              onClick={() => { setOpen(false); onRecover(g.rows) }}
              className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[11px] text-[var(--color-text-dim)] transition hover:bg-[rgba(var(--color-accent-rgb),0.1)] hover:text-[var(--color-accent)]"
            >
              <span>{AREA_LABEL[g.area] ?? g.area}</span>
              <span className="text-[var(--color-text-faint)]">{g.rows.length}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function AreaHeader({ area, count }: { area: string; count: number }) {
  return (
    <div className="mb-1 mt-1 flex items-baseline gap-2 text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-faint)]">
      {AREA_LABEL[area] ?? area}
      <span className="text-[var(--color-border-strong)]">{count}</span>
    </div>
  )
}

export function SessionBoard() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [here, setHere] = useState<string | null>(null)
  const [openingId, setOpeningId] = useState<string | null>(null)
  const [stoppingId, setStoppingId] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [recovering, setRecovering] = useState(false)
  const [recoverDone, setRecoverDone] = useState(0)
  // What this run is reopening, which is the whole desk or one area of it.
  const [recoverTotal, setRecoverTotal] = useState(0)
  const [showDone, setShowDone] = useState(false)
  const [openMode, setOpenMode] = useState<OpenMode>(readOpenMode)
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const [stoppingAll, setStoppingAll] = useState(false)
  const [stopAllDone, setStopAllDone] = useState(0)
  const [stopAllTotal, setStopAllTotal] = useState(0)
  const [stopAllFailed, setStopAllFailed] = useState(0)
  // One click arms it, a second within a few seconds fires. Every running
  // session at once is the one thing on this page a second click cannot undo,
  // so it costs two clicks where everything else costs one.
  const [stopAllArmed, setStopAllArmed] = useState(false)

  useEffect(() => { void localHostname().then(setHere) }, [])
  useEffect(() => {
    if (!stopAllArmed) return
    const t = setTimeout(() => setStopAllArmed(false), 4000)
    return () => clearTimeout(t)
  }, [stopAllArmed])

  // Poll: whether a session is running changes the moment a terminal closes,
  // and a list frozen at page load once left a closed session reading "running"
  // with its open button disabled.
  const q = useQuery({
    queryKey: ['sessionList'],
    queryFn: fetchSessionList,
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
  })

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['sessionList'] })
    void qc.invalidateQueries({ queryKey: ['workspaces'] })
  }

  // The SSH hop is only for reaching a DIFFERENT machine. Gating on "am I in
  // the app" made thor SSH to its own address and sit at a password prompt.
  const remote = here !== null && here !== HOST
  // A browser (the phone, above all) cannot open a local terminal and has no
  // use for a tab on thor's screen, so there "open" means the in-page terminal:
  // Claude resumes on thor over SSH and the phone is its screen. The desktop
  // app can do both, and the choice is the toggle in the header below.
  const inPage = openMode === 'page'
  const chooseMode = (mode: OpenMode) => {
    setOpenMode(mode)
    try { localStorage.setItem(OPEN_MODE_KEY, mode) } catch { /* private window */ }
  }

  const open = useMutation({
    mutationFn: async (s: WorkSession) => {
      // A session's transcript is local to the machine it ran on, so resume
      // goes back to that machine. The in-page terminal is a tmux pane SSHing
      // into thor and nowhere else, which is why it is thor-only here.
      if (s.host !== HOST) return void (await launchSessionOnHost(s.sessionId, '', s.host))
      if (inPage) {
        const r = await openTermSession({ mode: 'resume', sessionId: s.sessionId, label: s.title })
        seedTerminal(qc, r)
        navigate(termPath(r.name))
        return
      }
      if (remote) return openSessionHere(s.sessionId, HOST_IP, s.launchGroup)
      await launchSessionOnHost(s.sessionId, '', HOST)
    },
    onSettled: () => { setOpeningId(null); refresh() },
  })
  const stop = useMutation({
    mutationFn: (s: WorkSession) => stopSessionOnHost(s.sessionId, s.host),
    onSettled: () => { setStoppingId(null); refresh() },
  })
  const done = useMutation({
    mutationFn: (s: WorkSession) => setSessionDone(s.sessionId, !s.done, s.host),
    onSuccess: refresh,
  })
  // One call per host, not one per row. thor rewrites its disposition file
  // whole, so a fan-out of twenty requests has twenty copies of that file in
  // flight and the last one back erases the other nineteen marks.
  const doneMany = useMutation({
    mutationFn: async ({ rows, next }: { rows: WorkSession[]; next: boolean }) => {
      const byHost = new Map<string, string[]>()
      for (const s of rows) byHost.set(s.host, [...(byHost.get(s.host) ?? []), s.sessionId])
      for (const [host, ids] of byHost) await setSessionsDone(ids, next, host)
    },
    onSuccess: () => { setPicked({}); refresh() },
  })

  // Which conversations are already open in an in-page terminal. A resumed
  // terminal records the conversation id it was opened with, so this is an
  // exact match rather than a guess about folders. Same query key as
  // OpenTerminals, so it is one fetch shared through the cache.
  const terms = useQuery({ queryKey: ['term', 'sessions'], queryFn: fetchTermSessions, refetchInterval: 15_000 })
  const attachedTerminals = useMemo(() => {
    const m = new Map<string, string>()
    for (const t of terms.data ?? []) {
      // sessionId covers a terminal opened on a target, which knows its
      // conversation id from the moment it is created; target is where a
      // resume has always kept it.
      const id = t.sessionId || (t.mode === 'resume' ? t.target : '')
      if (id && !t.dead) m.set(id, t.name)
    }
    return m
  }, [terms.data])

  // What the board calls each conversation, for the chips above to borrow.
  const titleById = useMemo(() => {
    const m = new Map<string, string>()
    for (const s of (q.data?.installed ? q.data.sessions : [])) if (s.title) m.set(s.sessionId, s.title)
    return m
  }, [q.data])

  // What "stop all" closes besides the session rows. A dead one is a pane tmux
  // is holding open so its last screen can be read, so there is nothing left in
  // it to stop.
  const liveTerminals = useMemo(() => (terms.data ?? []).filter((t) => !t.dead), [terms.data])

  const { live, rest, doneList, desk } = useMemo(() => {
    const all = q.data?.installed ? q.data.sessions : []
    return {
      live: all.filter((s) => s.live),
      // "recent" means recent AND still open. Done rows arrive in the payload
      // (undo needs them) but live in their own collapsed section: after the
      // fresh start everything finished is done, so this is what keeps the
      // default view at "what am I working on" instead of "what happened".
      rest: all.filter((s) => !s.live && !s.done),
      doneList: all.filter((s) => !s.live && s.done),
      // Everything still open and not running: reopening is one action rather
      // than a click per row. Already-running and finished sessions are
      // excluded, so pressing it twice does nothing.
      //
      // This used to also require onDesk, and that quietly crippled it. The
      // desk is a 72-hour union of what was LIVE, so with 21 sessions open the
      // button offered 4 and silently ignored the rest. Time is not what
      // decides whether Brendon still wants a session: done is. Same mistake as
      // the age window that once hid 11 sessions from the board itself.
      desk: all.filter((s) => !s.live && !s.done && s.host === HOST),
    }
  }, [q.data])

  if (q.isLoading) return <div className="py-2 text-[11px] text-[var(--color-text-faint)]">reading sessions…</div>
  if (q.data && !q.data.installed) {
    return (
      <div className="py-2 text-[11px] text-[var(--color-warning)]">
        Sessions unavailable ({q.data.status}). {q.data.detail ?? ''}
      </div>
    )
  }
  if (q.isError) return <div className="py-2 text-[11px] text-[var(--color-danger)]">{(q.error as Error)?.message}</div>

  // Serial, with the same pause the launcher uses: Windows Terminal drops tabs
  // when several arrive at once.
  const recoverDesk = async (rows: WorkSession[]) => {
    if (rows.length === 0) return
    setRecovering(true)
    setRecoverDone(0)
    setRecoverTotal(rows.length)
    // Same group together, so each Windows Terminal window is created once and
    // every later tab of that group attaches to one that already exists.
    // Interleaved, the first two work sessions raced: `wt -w work` looks for a
    // window by name, and a window still starting up has not registered its
    // name yet, so the second call made a SECOND work window. Order inside a
    // group is untouched, which is the only order that shows.
    const ordered = [...rows].sort((a, b) => (a.launchGroup ?? '').localeCompare(b.launchGroup ?? ''))
    // 21 sessions is a long silence with no counter, and the earlier version
    // gave none: it just sat on "recovering…" for half a minute.
    let lastGroup: string | null = null
    for (const s of ordered) {
      setOpeningId(s.sessionId)
      try {
        if (remote) await openSessionHere(s.sessionId, HOST_IP, s.launchGroup)
        else await launchSessionOnHost(s.sessionId, '', HOST)
      } catch { /* one failure must not abandon the rest */ }
      setRecoverDone((n) => n + 1)
      // The tab that opens a window waits longer than one joining it: a cold
      // Windows Terminal takes seconds to appear, and 700ms was measured
      // against a window that was already up.
      const opensWindow = remote && s.launchGroup !== lastGroup
      lastGroup = s.launchGroup
      await new Promise((r) => setTimeout(r, opensWindow ? 3000 : 700))
    }
    setOpeningId(null)
    setRecovering(false)
    refresh()
  }

  // Serial, and that is not a style choice. A stop on an SSH-opened session
  // runs elevated, and thor escalates it through ONE kill-request.json handed
  // to a single scheduled task. Two stops in flight overwrite that file, so a
  // fan-out would kill one session and silently drop the rest.
  const stopAll = async (rows: WorkSession[], terminals: TermSession[]) => {
    if (rows.length + terminals.length === 0) return
    setStopAllArmed(false)
    setStoppingAll(true)
    setStopAllDone(0)
    setStopAllFailed(0)
    setStopAllTotal(rows.length + terminals.length)
    let failed = 0
    const bumpFailed = (e: unknown) => {
      // 404 is not a refusal: it means nothing is running under that id. Both
      // lists are polls (10s for sessions, 15s for terminals), so something
      // that exited on its own is still drawn as running and would otherwise
      // be reported as a failure.
      if (httpStatus(e) === 404) return
      failed += 1
      setStopAllFailed(failed)
    }

    // Terminals first. An in-page terminal is a tmux session whose pane runs
    // Claude on thor, so closing it ends that Claude too: doing these first
    // means the session sweep below finds them already gone and absorbs the
    // 404, rather than killing Claude and leaving an empty terminal behind.
    for (const t of terminals) {
      try {
        await killTermSession(t.name)
      } catch (e) {
        bumpFailed(e)
      }
      setStopAllDone((n) => n + 1)
    }

    for (const s of rows) {
      setStoppingId(s.sessionId)
      try {
        await stopSessionOnHost(s.sessionId, s.host)
      } catch (e) {
        // An elevated stop takes up to 12s and can still come back refused.
        // One that does must not abandon the sessions behind it.
        bumpFailed(e)
      }
      setStopAllDone((n) => n + 1)
    }
    setStoppingId(null)
    setStoppingAll(false)
    refresh()
    void qc.invalidateQueries({ queryKey: ['term', 'sessions'] })
  }

  // Both lists are things Brendon can see running: the chips in the "in page"
  // row and the live session rows. A resume terminal and its session row are
  // two of those, and stopping both is one no-op 404, which the sweep absorbs.
  const stopAllCount = live.length + liveTerminals.length
  const busy = done.isPending || doneMany.isPending || stoppingAll
  const shown = showAll ? rest : rest.slice(0, SHOWN_BY_DEFAULT)
  const hidden = rest.length - shown.length
  // Every row a checkbox is drawn next to right now. "pick all" means what is
  // on the screen, never the older rows folded away behind "show N older".
  const onScreen = [...live, ...shown, ...(showDone ? doneList : [])]
  const pickedRows = onScreen.filter((s) => picked[s.sessionId])
  const pickedOpen = pickedRows.filter((s) => !s.done)
  const pickedDone = pickedRows.filter((s) => s.done)
  const allPicked = onScreen.length > 0 && pickedRows.length === onScreen.length
  const rowProps = {
    remote, here, inPage, busy,
    onPick: (s: WorkSession, next: boolean) => setPicked((prev) => ({ ...prev, [s.sessionId]: next })),
    onReattach: (terminal: string) => navigate(termPath(terminal)),
    onOpen: (s: WorkSession) => { setOpeningId(s.sessionId); open.mutate(s) },
    onStop: (s: WorkSession) => { setStoppingId(s.sessionId); stop.mutate(s) },
    onDone: (s: WorkSession) => done.mutate(s),
  }

  return (
    <div>
      <OpenTerminals titles={titleById} />
      <div className="mb-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="text-[11px] text-[var(--color-text-faint)]">
          {live.length > 0 ? `${live.length} running · ` : ''}{rest.length} recent
          {inPage ? ' · opens in the page' : remote && here ? ` · opening on ${here}` : ''}
        </div>
        <div className="flex items-center gap-2">
        {isTauri() && !isTauriMobile() && (
          // Desktop only. A browser or the Android app has no second option to offer.
          <div className="flex items-center border border-[var(--color-border)] text-[10px] uppercase tracking-[0.12em]">
            {(['page', 'screen'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => chooseMode(mode)}
                title={mode === 'page'
                  ? 'Open sessions inside Valkyrie, running on thor over SSH'
                  : `Open sessions in a terminal window on ${here ?? HOST}`}
                className={`min-h-9 px-2.5 transition ${openMode === mode
                  ? 'bg-[rgba(var(--color-accent-rgb),0.12)] text-[var(--color-accent)]'
                  : 'text-[var(--color-text-faint)] hover:text-[var(--color-text-dim)]'}`}
              >
                {mode === 'page' ? 'in page' : 'on screen'}
              </button>
            ))}
          </div>
        )}
        {stopAllCount > 0 && (
          <button
            type="button"
            disabled={stoppingAll || recovering}
            onClick={() => (stopAllArmed ? void stopAll(live, liveTerminals) : setStopAllArmed(true))}
            title={stopAllArmed
              ? `Click again to stop all ${stopAllCount}`
              : liveTerminals.length > 0
                ? `Stop every running session and close every terminal open in the page. Transcripts are kept, so each one reopens whenever you want it.`
                : `Stop every running session. Transcripts are kept, so each one reopens whenever you want it.`}
            className={`inline-flex min-h-9 items-center gap-1.5 border px-2.5 text-[10px] uppercase tracking-[0.1em] transition disabled:opacity-40 ${stopAllArmed
              ? 'border-[var(--color-danger)] bg-[var(--color-danger)]/10 text-[var(--color-danger)]'
              : 'border-[var(--color-border)] text-[var(--color-text-faint)] hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]'}`}
          >
            <Square size={11} />
            {stoppingAll
              ? `stopping ${stopAllDone}/${stopAllTotal}`
              : stopAllArmed ? `stop all ${stopAllCount}?` : `stop all ${stopAllCount}`}
          </button>
        )}
        <NewSession onStarted={refresh} inPage={inPage} remote={remote} />
        {desk.length > 0 && (
          <RecoverDesk
            desk={desk}
            disabled={recovering || openingId !== null}
            recovering={recovering}
            done={recoverDone}
            total={recoverTotal}
            onRecover={(rows) => void recoverDesk(rows)}
          />
        )}
        </div>
      </div>

      {/* The bar only exists once something is checked, so a desk nobody is
          clearing keeps the list it had. */}
      {pickedRows.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-2 border border-[var(--color-accent)]/50 bg-[rgba(var(--color-accent-rgb),0.06)] px-2.5 py-2 text-[11px]">
          <span className="text-[var(--color-text-dim)]">{pickedRows.length} picked</span>
          {pickedOpen.length > 0 && (
            <button
              type="button"
              disabled={doneMany.isPending}
              onClick={() => doneMany.mutate({ rows: pickedOpen, next: true })}
              title="Mark every picked session done. It goes to the done section, where undo lives."
              className="inline-flex min-h-9 items-center gap-1.5 border border-[var(--color-accent)] px-2.5 text-[10px] uppercase tracking-[0.1em] text-[var(--color-accent)] transition hover:bg-[var(--color-accent)]/10 disabled:opacity-40"
            >
              <Check size={12} /> {doneMany.isPending ? 'marking…' : `mark ${pickedOpen.length} done`}
            </button>
          )}
          {pickedDone.length > 0 && (
            <button
              type="button"
              disabled={doneMany.isPending}
              onClick={() => doneMany.mutate({ rows: pickedDone, next: false })}
              title="Put every picked session back on the list"
              className="inline-flex min-h-9 items-center gap-1.5 border border-[var(--color-border-strong)] px-2.5 text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-dim)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-40"
            >
              <Undo2 size={12} /> undo {pickedDone.length}
            </button>
          )}
          {!allPicked && (
            <button
              type="button"
              onClick={() => setPicked(Object.fromEntries(onScreen.map((s) => [s.sessionId, true])))}
              className="min-h-9 px-1 text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-faint)] transition hover:text-[var(--color-accent)]"
            >
              pick all {onScreen.length}
            </button>
          )}
          <button
            type="button"
            onClick={() => setPicked({})}
            className="ml-auto min-h-9 px-1 text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-faint)] transition hover:text-[var(--color-accent)]"
          >
            clear
          </button>
        </div>
      )}

      {/* Grouped by area, work first. A header appears once a block spans more
          than one area: labelling a single-area block adds a line and says
          nothing the row does not. */}
      {groupByArea(live).map((g, i) => (
        <div key={`live-${g.area}`} className={i > 0 ? 'mt-3' : ''}>
          {groupByArea(live).length > 1 && <AreaHeader area={g.area} count={g.rows.length} />}
          {g.rows.map((s) => (
            <Row key={s.sessionId} attachedTo={attachedTerminals.get(s.sessionId) ?? null} s={s} {...rowProps}
              picked={picked[s.sessionId] === true}
              opening={openingId === s.sessionId} stopping={stoppingId === s.sessionId} />
          ))}
        </div>
      ))}
      {live.length > 0 && rest.length > 0 && <div className="h-3" />}
      {groupByArea(shown).map((g, i) => (
        <div key={`rest-${g.area}`} className={i > 0 ? 'mt-3' : ''}>
          {groupByArea(shown).length > 1 && <AreaHeader area={g.area} count={g.rows.length} />}
          {g.rows.map((s) => (
            <Row key={s.sessionId} attachedTo={attachedTerminals.get(s.sessionId) ?? null} s={s} {...rowProps}
              picked={picked[s.sessionId] === true}
              opening={openingId === s.sessionId} stopping={stoppingId === s.sessionId} />
          ))}
        </div>
      ))}

      {live.length === 0 && rest.length === 0 && (
        <div className="py-3 text-[11px] text-[var(--color-text-faint)]">
          Nothing open. Finished sessions are under done, and a new one appears here the moment you start it.
        </div>
      )}

      <div className="mt-3 flex items-center gap-4">
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="text-[11px] text-[var(--color-text-faint)] transition hover:text-[var(--color-accent)]"
          >
            show {hidden} older
          </button>
        )}
        {doneList.length > 0 && (
          <button
            type="button"
            onClick={() => setShowDone((v) => !v)}
            className="text-[11px] text-[var(--color-text-faint)] transition hover:text-[var(--color-accent)]"
          >
            {showDone ? 'hide done' : `show ${doneList.length} done`}
          </button>
        )}
      </div>
      {showDone && (
        <div className="mt-1 opacity-60">
          {doneList.map((s) => (
            <Row key={s.sessionId} attachedTo={attachedTerminals.get(s.sessionId) ?? null} s={s} {...rowProps}
              picked={picked[s.sessionId] === true}
              opening={openingId === s.sessionId} stopping={stoppingId === s.sessionId} />
          ))}
        </div>
      )}

      {/* A sweep that refused some sessions must say so. The rows themselves
          go back to "running" on the next poll, which reads as nothing having
          happened at all. */}
      {!stoppingAll && stopAllFailed > 0 && (
        <div className="mt-2 text-[11px] text-[var(--color-danger)]">
          {stopAllFailed} of {stopAllTotal} would not stop. They are still running.
        </div>
      )}
      {(open.isError || stop.isError || done.isError || doneMany.isError) && (
        <div className="mt-2 text-[11px] text-[var(--color-danger)]">
          {((open.error ?? stop.error ?? done.error ?? doneMany.error) as Error)?.message}
        </div>
      )}
    </div>
  )
}
