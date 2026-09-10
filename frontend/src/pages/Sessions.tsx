import { useMemo, useState } from 'react'
import { useIsFetching, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, Lock, Play, RefreshCw, Rocket } from 'lucide-react'
import { Card } from '../components/Card'
import { SessionBoard } from '../components/SessionBoard'
import {
  fetchWorkspaces, launchSessionOnHost,
  type WorkspaceHealth, type WorkspaceHost, type WorkspaceSession, type WorkspaceState,
} from '../lib/api'
import { copyText } from '../lib/clipboard'

// The Claude session desk: every session on every host in one place. Getting
// back into one is the whole point of the page, so the two ways of doing that
// (copy the resume command, or launch it on thor) sit on every row.

type Filter = WorkspaceState | 'all'

// thor and odin are always drawn, even when the board never mentioned them: a
// host that stopped reporting is the most useful thing this page can tell you,
// and an empty screen would hide it.
const EXPECTED_HOSTS = ['thor', 'odin']
const LAUNCH_HOST = 'thor'

function stateTone(state: WorkspaceState): string {
  if (state === 'asking') return 'text-[var(--color-warning)]'
  if (state === 'running') return 'text-[var(--color-success)]'
  if (state === 'idle') return 'text-[var(--color-text-dim)]'
  return 'text-[var(--color-text-faint)]'
}

function stateDot(state: WorkspaceState): string {
  if (state === 'asking') return 'bg-[var(--color-warning)]'
  if (state === 'running') return 'bg-[var(--color-success)]'
  if (state === 'idle') return 'bg-[var(--color-text-dim)]'
  return 'bg-[var(--color-text-faint)]'
}

function healthTone(health: WorkspaceHealth): string {
  if (health === 'healthy') return 'text-[var(--color-success)]'
  if (health === 'unhealthy') return 'text-[var(--color-danger)]'
  return 'text-[var(--color-warning)]'
}

// What the badge means, in Brendon's words rather than the enum's.
function healthMeaning(health: WorkspaceHealth): string {
  if (health === 'stale') return 'snapshot is older than the collector interval'
  if (health === 'unhealthy') return 'the snapshot could not be read, or the collector reported a failure'
  if (health === 'suspicious') return 'the session count changed sharply, so treat this list with care'
  return ''
}

function fmtAge(seconds: number | null): string {
  if (seconds == null) return 'age unknown'
  const s = Math.max(0, Math.round(seconds))
  if (s < 90) return `${s}s old`
  if (s < 5400) return `${Math.round(s / 60)}m old`
  if (s < 172800) return `${Math.round(s / 3600)}h old`
  return `${Math.round(s / 86400)}d old`
}

function relTime(iso: string | null): string {
  if (!iso) return 'unknown'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return 'unknown'
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 45) return 'just now'
  if (s < 5400) return `${Math.max(1, Math.round(s / 60))}m ago`
  if (s < 172800) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

function fmtBytes(bytes: number | null): string | null {
  if (bytes == null || bytes < 0) return null
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

const sessionKey = (s: WorkspaceSession) => `${s.host}:${s.sessionId ?? `${s.cwd}#${s.pid ?? 'x'}`}`

function CopyResumeButton({ command }: { command: string | null }) {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)

  if (!command) {
    return (
      <span
        title="This host published no resume command for the session"
        className="inline-flex min-h-10 items-center border border-dashed border-[var(--color-border)] px-3 text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-faint)]"
      >
        no resume command
      </span>
    )
  }

  const run = async () => {
    const ok = await copyText(command)
    setCopied(ok)
    setFailed(!ok)
    window.setTimeout(() => { setCopied(false); setFailed(false) }, 1600)
  }

  return (
    <button
      type="button"
      onClick={() => void run()}
      title={command}
      className={`inline-flex min-h-10 shrink-0 items-center gap-2 border px-3 text-[11px] uppercase tracking-[0.14em] transition active:border-[var(--color-accent)] ${
        copied
          ? 'border-[var(--color-accent)] bg-[rgba(var(--color-accent-rgb),0.12)] text-[var(--color-accent)]'
          : failed
            ? 'border-[var(--color-danger)] text-[var(--color-danger)]'
            : 'border-[var(--color-border-strong)] text-[var(--color-text)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]'
      }`}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {copied ? 'copied' : failed ? 'copy failed' : 'copy resume'}
    </button>
  )
}

function SessionRow({
  s, selected, selectable, onSelect, onLaunch, launching, launcherMissing,
}: {
  s: WorkspaceSession
  selected: boolean
  selectable: boolean
  onSelect: (next: boolean) => void
  onLaunch: () => void
  launching: boolean
  launcherMissing: boolean
}) {
  const size = fmtBytes(s.transcriptBytes)
  // A redacted session has no title by contract, so the folder name is the label.
  const heading = s.redacted ? s.project : (s.title ?? s.project)
  return (
    <div
      className={`border p-3 transition ${
        s.redacted
          ? 'border-dashed border-[var(--color-warning)]/40 bg-[color:rgba(255,255,255,0.01)]'
          : 'border-[var(--color-border)] bg-[color:rgba(255,255,255,0.02)] hover:border-[var(--color-border-strong)]'
      } ${selected ? 'border-[var(--color-accent)]' : ''}`}
    >
      <div className="flex min-w-0 items-start gap-3">
        {selectable && (
          <input
            type="checkbox"
            checked={selected}
            onChange={(e) => onSelect(e.target.checked)}
            aria-label={`Pick ${heading} for restore`}
            className="mt-1.5 h-4 w-4 shrink-0 cursor-pointer"
            style={{ accentColor: 'var(--color-accent)' }}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={`h-1.5 w-1.5 shrink-0 ${stateDot(s.state)}`} aria-hidden />
            <span className="min-w-0 truncate text-sm font-semibold text-[var(--color-text)]">{heading}</span>
            <span className={`text-[10px] uppercase tracking-[0.14em] ${stateTone(s.state)}`}>[{s.state}]</span>
            {s.redacted && (
              <span className="inline-flex items-center gap-1 border border-[var(--color-warning)]/50 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.14em] text-[var(--color-warning)]">
                <Lock size={9} /> withheld
              </span>
            )}
          </div>

          <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-faint)]">
            {s.name && <span>[{s.name}]</span>}
            <span>[{s.project}]</span>
            <span>[{s.area}]</span>
            {s.pid != null && <span>[pid {s.pid}]</span>}
          </div>

          {s.redacted && (
            <div className="mt-1 text-[11px] text-[var(--color-warning)]">
              client work: title and session name withheld on purpose
            </div>
          )}

          <div className="mt-1 break-all font-mono text-[11px] text-[var(--color-text-faint)] sm:truncate">{s.cwd}</div>

          <div className="mt-1 text-[11px] text-[var(--color-text-dim)]">
            active {relTime(s.lastActivityUtc)}
            {size && <span className="text-[var(--color-text-faint)]"> · {size}</span>}
            {s.messageCount != null && <span className="text-[var(--color-text-faint)]"> · {s.messageCount} msgs</span>}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <CopyResumeButton command={s.resumeCommand} />
            {s.host === LAUNCH_HOST && (
              <button
                type="button"
                onClick={onLaunch}
                disabled={launching || launcherMissing}
                title={launcherMissing ? `The ${LAUNCH_HOST} launcher is not installed yet` : `Open this session in a terminal on ${LAUNCH_HOST}`}
                className="inline-flex min-h-10 shrink-0 items-center gap-2 border border-[var(--color-border)] px-3 text-[11px] uppercase tracking-[0.14em] text-[var(--color-text-dim)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] active:border-[var(--color-accent)] disabled:opacity-40"
              >
                <Play size={12} /> {launching ? 'launching' : `launch on ${LAUNCH_HOST}`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function HostBadge({ host }: { host: WorkspaceHost }) {
  const notes = [
    host.health === 'healthy' ? null : healthMeaning(host.health),
    host.error,
    host.servedFromCache ? 'serving the last good snapshot' : null,
    host.droppedRecords > 0 ? `${host.droppedRecords} malformed record${host.droppedRecords === 1 ? '' : 's'} dropped` : null,
    // A cap, not a fault: thor keeps thousands of closed sessions and the API
    // serves the newest slice, so say so instead of implying data loss.
    host.truncatedRecords > 0 ? `${host.truncatedRecords} older session${host.truncatedRecords === 1 ? '' : 's'} not shown (payload cap)` : null,
  ].filter((n): n is string => Boolean(n))
  return (
    <div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
      <span className={`text-[10px] uppercase tracking-[0.16em] ${healthTone(host.health)}`}>
        [{host.health}{host.health !== 'healthy' ? ` · ${fmtAge(host.ageSeconds)}` : ''}]
      </span>
      {notes.length > 0 && (
        <span className="max-w-[300px] text-[10px] text-[var(--color-text-faint)]">{notes.join(' · ')}</span>
      )}
    </div>
  )
}

function FilterButton({ id, active, label, count, onClick }: { id: Filter; active: Filter; label: string; count: number; onClick: (id: Filter) => void }) {
  const selected = id === active
  return (
    <button
      type="button"
      onClick={() => onClick(id)}
      className={`border min-h-10 px-3 py-2 text-xs uppercase tracking-[0.16em] transition active:border-[var(--color-accent)] ${
        selected
          ? 'border-[var(--color-accent)] bg-[rgba(var(--color-accent-rgb),0.08)] text-[var(--color-accent)]'
          : 'border-[var(--color-border)] text-[var(--color-text-dim)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]'
      }`}
    >
      {label} <span className="text-[var(--color-text-faint)]">{count}</span>
    </button>
  )
}

// A host the board never mentioned still gets a card, so "thor stopped
// reporting" reads differently from "thor has no sessions".
const missingHost = (host: string): WorkspaceHost => ({
  host,
  health: 'unhealthy',
  ageSeconds: null,
  generatedAt: null,
  producerOk: false,
  sessionCount: 0,
  claudeVersion: null,
  lastBootUtc: null,
  servedFromCache: false,
  droppedRecords: 0,
  truncatedRecords: 0,
  error: 'this host is not in the board at all',
})

type LaunchOutcome = { launched: number; notInstalled: { status: number; detail: string | null } | null }

// Everything the page draws, by query key root. The button used to invalidate
// ['workspaces'] and ['threads'] only: 'threads' belongs to no query at all,
// and the session list on top of the page is ['sessionList'] plus ['term',
// 'sessions'], so pressing refresh re-read the host table and left the list
// itself untouched. That is why it looked dead.
const REFRESH_KEYS = ['sessionList', 'term', 'workspaces'] as const

export default function Sessions() {
  const qc = useQueryClient()
  // The snapshot behind this is minutes old by design, so the app-wide 15s
  // React Query default is already more than enough. No extra polling.
  const board = useQuery({ queryKey: ['workspaces'], queryFn: fetchWorkspaces })
  const [showAll, setShowAll] = useState(false)
  const [filter, setFilter] = useState<Filter>('asking')
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  const [launcherMissing, setLauncherMissing] = useState<{ status: number; detail: string | null } | null>(null)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const [refreshed, setRefreshed] = useState(false)

  // Spin while any of the three is in flight, not just the host table.
  const refreshing = useIsFetching({
    predicate: (q) => (REFRESH_KEYS as readonly string[]).includes(String(q.queryKey[0])),
  }) > 0

  // An honest refresh often returns the same rows, so the click needs to say
  // it ran. Without that the button reads as broken even when it worked.
  const refreshAll = () => {
    setRefreshed(false)
    void Promise.all(REFRESH_KEYS.map((key) => qc.invalidateQueries({ queryKey: [key] })))
      .then(() => {
        setRefreshed(true)
        setTimeout(() => setRefreshed(false), 1500)
      })
  }

  const result = board.data
  const routeMissing = result && !result.installed ? result : null
  const data = result?.installed ? result.data : null

  const hosts = useMemo<WorkspaceHost[]>(() => {
    const reported = data?.hosts ?? []
    const byName = new Map(reported.map((h) => [h.host, h]))
    const known = EXPECTED_HOSTS.map((name) => byName.get(name) ?? missingHost(name))
    const extra = reported.filter((h) => !EXPECTED_HOSTS.includes(h.host)).sort((a, b) => a.host.localeCompare(b.host))
    return [...known, ...extra]
  }, [data])

  // Memoized so the empty-array fallback doesn't hand the filters a new
  // identity on every render.
  const sessions = useMemo<WorkspaceSession[]>(() => data?.sessions ?? [], [data])
  const counts = useMemo(() => ({
    all: sessions.length,
    asking: sessions.filter((s) => s.state === 'asking').length,
    running: sessions.filter((s) => s.state === 'running').length,
    idle: sessions.filter((s) => s.state === 'idle').length,
    closed: sessions.filter((s) => s.state === 'closed').length,
  }), [sessions])

  const q = query.trim().toLowerCase()
  // A redacted row matches on project and cwd only: its title and name are not
  // in the payload at all, so there is nothing else to search.
  const visible = useMemo(
    () => sessions.filter((s) => (filter === 'all' || s.state === filter)
      && (!q || `${s.title ?? ''} ${s.name ?? ''} ${s.project} ${s.cwd}`.toLowerCase().includes(q))),
    [sessions, filter, q],
  )
  const visibleByHost = useMemo(() => {
    const m = new Map<string, WorkspaceSession[]>()
    for (const s of visible) m.set(s.host, [...(m.get(s.host) ?? []), s])
    return m
  }, [visible])

  const launchable = visible.filter((s) => s.host === LAUNCH_HOST)
  const pickedRows = launchable.filter((s) => picked[sessionKey(s)])

  // Sequential on purpose: each launch opens a terminal on thor, and firing a
  // dozen at once is how you end up with a screen full of half-started shells.
  const runLaunches = async (rows: WorkspaceSession[]): Promise<LaunchOutcome> => {
    let launched = 0
    for (const s of rows) {
      setPendingKey(sessionKey(s))
      const res = await launchSessionOnHost(s.sessionId, s.cwd, s.host)
      if (!res.ok) return { launched, notInstalled: { status: res.status, detail: res.detail } }
      launched += 1
    }
    return { launched, notInstalled: null }
  }

  const launch = useMutation({
    mutationFn: runLaunches,
    onSuccess: (res) => {
      if (res.notInstalled) {
        setLauncherMissing(res.notInstalled)
        setNotice(null)
      } else {
        setNotice({ tone: 'ok', text: `${res.launched} session${res.launched === 1 ? '' : 's'} launched on ${LAUNCH_HOST}` })
      }
    },
    onError: (err) => setNotice({ tone: 'bad', text: (err as Error).message || 'launch failed' }),
    onSettled: () => setPendingKey(null),
  })

  const startLaunch = (rows: WorkspaceSession[]) => {
    if (rows.length === 0 || launch.isPending) return
    setNotice(null)
    launch.mutate(rows)
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-[9px] uppercase tracking-[0.35em] text-[var(--color-text-faint)]">// claude desk</div>
          <h1 className="mt-1 text-2xl font-bold tracking-[0.12em]" style={{ color: 'var(--color-accent)', textShadow: '0 0 16px var(--color-accent)' }}>sessions<span className="cursor-blink">_</span></h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="text-xs uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
            [{counts.asking} asking · {counts.running} running · {counts.idle} idle · {counts.closed} closed]
          </div>
          <button
            type="button"
            onClick={refreshAll}
            title="Re-read the session list and the host board"
            className={`inline-flex min-h-10 items-center gap-2 border px-3 text-[10px] uppercase tracking-[0.16em] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] ${refreshed ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-text-dim)]'}`}
          >
            <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} /> {refreshed ? 'refreshed' : 'refresh'}
          </button>
        </div>
      </div>

      {counts.asking > 0 && (
        <button
          type="button"
          onClick={() => setFilter('asking')}
          className="flex w-full items-center justify-between gap-3 border border-[var(--color-warning)]/50 bg-[color:rgba(255,255,255,0.02)] px-3 py-2 text-left text-xs uppercase tracking-[0.16em] text-[var(--color-warning)] transition hover:border-[var(--color-warning)]"
        >
          <span>{counts.asking} session{counts.asking === 1 ? '' : 's'} waiting on you</span>
          <span className="text-[10px] text-[var(--color-text-faint)]">show</span>
        </button>
      )}

      {notice && (
        <div className={`border px-3 py-2 text-xs ${notice.tone === 'ok' ? 'border-[var(--color-accent)] bg-[rgba(var(--color-accent-rgb),0.08)] text-[var(--color-accent)]' : 'border-[var(--color-danger)] text-[var(--color-danger)]'}`}>
          {notice.text}
        </div>
      )}

      {launcherMissing && (
        <div className="border border-[var(--color-warning)]/50 px-3 py-2 text-xs text-[var(--color-warning)]">
          Launcher unavailable: POST /api/hosts/{LAUNCH_HOST}/launch answered {launcherMissing.status}. 501 means it is not configured on the api host, 502 means {LAUNCH_HOST} is not answering.
          {launcherMissing.detail ? ` ${launcherMissing.detail}.` : ''} Copy a resume command instead, that path works today.
        </div>
      )}

      {/* The page. Everything below is detail, folded away by default: the
          455-row session list never once answered "what am I working on". */}
      <Card title="working on">
        <SessionBoard />
      </Card>

      <button
        type="button"
        onClick={() => setShowAll((v) => !v)}
        className="text-[11px] text-[var(--color-text-faint)] transition hover:text-[var(--color-accent)]"
      >
        {showAll ? 'hide' : 'show'} all {counts.all} sessions
      </button>
      {showAll && (<>
      <div className="flex flex-wrap items-center gap-2">
        <FilterButton id="asking" active={filter} label="Asking" count={counts.asking} onClick={setFilter} />
        <FilterButton id="running" active={filter} label="Running" count={counts.running} onClick={setFilter} />
        <FilterButton id="idle" active={filter} label="Idle" count={counts.idle} onClick={setFilter} />
        <FilterButton id="closed" active={filter} label="Closed" count={counts.closed} onClick={setFilter} />
        <FilterButton id="all" active={filter} label="All" count={counts.all} onClick={setFilter} />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search title, name, project, path"
          className="min-w-52 flex-1 border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-base sm:text-sm text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)]"
        />
      </div>

      {launchable.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 border border-[var(--color-border)] px-3 py-2">
          <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-[var(--color-text-faint)]">
            <span>{pickedRows.length} of {launchable.length} picked</span>
            <button
              type="button"
              onClick={() => setPicked(Object.fromEntries(launchable.map((s) => [sessionKey(s), true])))}
              className="border border-[var(--color-border)] px-2 py-1 transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
            >
              pick all shown
            </button>
            <button
              type="button"
              onClick={() => setPicked({})}
              className="border border-[var(--color-border)] px-2 py-1 transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
            >
              clear
            </button>
          </div>
          <button
            type="button"
            onClick={() => startLaunch(pickedRows)}
            disabled={pickedRows.length === 0 || launch.isPending || launcherMissing != null}
            title={launcherMissing ? `The ${LAUNCH_HOST} launcher is not installed yet` : `Launch every picked session on ${LAUNCH_HOST}`}
            className="inline-flex min-h-10 items-center gap-2 border border-[var(--color-border-strong)] px-3 text-[11px] uppercase tracking-[0.14em] text-[var(--color-text)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-40"
          >
            <Rocket size={13} /> {launch.isPending ? 'restoring' : `restore my desk (${pickedRows.length})`}
          </button>
        </div>
      )}

      {board.isLoading && !board.data && (
        <Card title="board">
          <div className="text-sm text-[var(--color-text-dim)]">Loading…</div>
        </Card>
      )}

      {board.error && (
        <Card title="board">
          <div className="text-sm text-[var(--color-danger)]">Session board unavailable</div>
          <div className="mt-1 text-[11px] text-[var(--color-text-faint)]">{(board.error as Error).message}</div>
        </Card>
      )}

      {routeMissing && (
        <Card title="board not installed">
          <div className="text-sm text-[var(--color-text-dim)]">
            GET /api/workspaces answered {routeMissing.status}. This backend does not serve the session board yet, so there is nothing to show.
          </div>
          {routeMissing.detail && <div className="mt-1 text-[11px] text-[var(--color-text-faint)]">{routeMissing.detail}</div>}
        </Card>
      )}


      {data && hosts.map((host) => {
        const rows = visibleByHost.get(host.host) ?? []
        const hostTotal = sessions.filter((s) => s.host === host.host).length
        return (
          <Card key={host.host} title={`${host.host} · ${hostTotal} sessions`} action={<HostBadge host={host} />}>
            {(host.claudeVersion || host.generatedAt) && (
              <div className="mb-3 text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-faint)]">
                {host.claudeVersion ? `[claude ${host.claudeVersion}] ` : ''}
                {host.generatedAt ? `[snapshot ${relTime(host.generatedAt)}]` : ''}
              </div>
            )}
            {hostTotal === 0 ? (
              <div className="text-sm text-[var(--color-text-dim)]">
                {host.health === 'healthy'
                  ? `${host.host} is reporting and has no sessions right now.`
                  : `No sessions from ${host.host}. This is not an empty desk, the host is not reporting: ${healthMeaning(host.health)}.`}
              </div>
            ) : rows.length === 0 ? (
              <div className="text-sm text-[var(--color-text-dim)]">
                None of {host.host}&apos;s {hostTotal} sessions match {filter === 'all' ? 'the search' : `the ${filter} filter`}
                {q ? ` and "${query.trim()}"` : ''}.
              </div>
            ) : (
              <div className="space-y-2">
                {rows.map((s) => {
                  const key = sessionKey(s)
                  return (
                    <SessionRow
                      key={key}
                      s={s}
                      selected={picked[key] === true}
                      selectable={s.host === LAUNCH_HOST}
                      onSelect={(next) => setPicked((prev) => ({ ...prev, [key]: next }))}
                      onLaunch={() => startLaunch([s])}
                      launching={launch.isPending && pendingKey === key}
                      launcherMissing={launcherMissing != null}
                    />
                  )
                })}
              </div>
            )}
          </Card>
        )
      })}
      </>)}

      {data && sessions.length === 0 && (
        <Card title="nothing collected yet">
          <div className="text-sm text-[var(--color-text-dim)]">
            No host has published a session yet. thor writes its snapshot on a timer, and sessions show up here as soon as that file lands.
          </div>
          {data.generatedAt && (
            <div className="mt-1 text-[11px] text-[var(--color-text-faint)]">board built {relTime(data.generatedAt)}</div>
          )}
        </Card>
      )}
    </div>
  )
}
