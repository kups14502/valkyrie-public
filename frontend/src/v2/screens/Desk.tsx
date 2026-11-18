import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  fetchLaunchTargets, fetchSessionList, fetchTermSessions, openTermSession, termLabel,
  type TermOpen, type TermSession,
} from '../../lib/api'
import { TERM_NAME_RE, errText, v2TermPath } from '../../lib/term'
import type { DeskHost } from '../../lib/embed'
import type { ScreenProps } from '../kit/shell'
import { Press, toast } from '../kit/ui'
import './desk.css'

// The Desk tab (/m/desk), on the headset profile only (v2/App.tsx): several
// sessions side by side, which a headset has the room for and a phone does
// not. It replaced the classic VR workspace (pages/Vr.tsx). Every screen is the
// v2 terminal's pop-out page (/m/w/term/<name>) in an iframe, so a screen is
// exactly the terminal a pop-out window would show, keys row and composer
// included, minus the status strip this tab already has. The terminals ask the
// desk for what a pop-out does for itself through window.valkyrieDesk
// (lib/embed.ts): picking another session adds a screen, closing leaves one.
//
// Which sessions are on the desk, and the column count, are kept per device.

const PANES_KEY = 'v2.desk.panes'
const COLS_KEY = 'v2.desk.cols'
const MAX = 6
// The terminal page's default font, for sizing a session before its screen attaches.
const FONT_PX = 14

type Cols = 0 | 1 | 2 | 3

const EMPTY: TermSession[] = []

function loadPanes(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PANES_KEY) || '[]') as unknown
    if (!Array.isArray(raw)) return []
    return [...new Set(raw.filter((n): n is string => typeof n === 'string' && TERM_NAME_RE.test(n)))].slice(0, MAX)
  } catch {
    return []
  }
}

function loadCols(): Cols {
  const v = Number(localStorage.getItem(COLS_KEY))
  return v === 1 || v === 2 || v === 3 ? v : 0
}

const autoCols = (n: number) => (n <= 1 ? 1 : n <= 3 ? n : n === 4 ? 2 : 3)

export default function Desk({ active }: ScreenProps) {
  const navigate = useNavigate()
  const [panes, setPanes] = useState<string[]>(loadPanes)
  const [cols, setCols] = useState<Cols>(loadCols)
  const [picker, setPicker] = useState(false)
  const frames = useRef(new Map<string, HTMLIFrameElement>())
  const stageRef = useRef<HTMLDivElement>(null)

  const sessions = useQuery({ queryKey: ['term', 'sessions'], queryFn: fetchTermSessions, enabled: active })
  const board = useQuery({ queryKey: ['sessionList'], queryFn: fetchSessionList, enabled: active, staleTime: 10_000 })
  const titles = useMemo(() => {
    const m = new Map<string, string>()
    if (board.data?.installed) for (const s of board.data.sessions) m.set(s.sessionId, s.title)
    return m
  }, [board.data])
  const byName = useMemo(() => new Map((sessions.data ?? EMPTY).map((s) => [s.name, s])), [sessions.data])

  useEffect(() => { try { localStorage.setItem(PANES_KEY, JSON.stringify(panes)) } catch { /* storage unavailable */ } }, [panes])
  useEffect(() => { try { localStorage.setItem(COLS_KEY, String(cols)) } catch { /* storage unavailable */ } }, [cols])

  const add = useCallback((name: string) => {
    setPanes((prev) => {
      if (prev.includes(name)) return prev
      if (prev.length >= MAX) {
        toast(`${MAX} sessions is the most the desk shows. Hide one first.`, { ms: 4000 })
        return prev
      }
      return [...prev, name]
    })
    setPicker(false)
  }, [])

  const hide = useCallback((name: string) => setPanes((prev) => prev.filter((n) => n !== name)), [])

  // What the terminal in a screen asks for (lib/embed.ts DeskHost).
  useEffect(() => {
    const host: DeskHost = {
      open: (name) => add(name),
      close: (from) => {
        for (const [name, el] of frames.current) if (el.contentWindow === from) hide(name)
      },
    }
    const w = window as Window & { valkyrieDesk?: DeskHost }
    w.valkyrieDesk = host
    return () => { if (w.valkyrieDesk === host) delete w.valkyrieDesk }
  }, [add, hide])

  const n = panes.length
  const c = cols || autoCols(n)

  // A new session starts at about the size of the screen it is about to fill.
  const grid = () => {
    const k = n + 1
    const cc = cols || autoCols(k)
    const w = (stageRef.current?.clientWidth ?? 1600) / cc
    const h = (stageRef.current?.clientHeight ?? 900) / Math.ceil(k / cc)
    return { cols: Math.max(40, Math.floor((w - 24) / (FONT_PX * 0.6))), rows: Math.max(12, Math.floor((h - 150) / (FONT_PX * 1.32))) }
  }

  return (
    <div className="dk">
      <div className="dk-bar">
        <Press className="dk-add" onPress={() => setPicker((v) => !v)} aria-expanded={picker}>+ Session</Press>
        <span className="dk-count">{n} of {MAX}</span>
        <div className="dk-cols" role="group" aria-label="Columns">
          {([0, 1, 2, 3] as Cols[]).map((v) => (
            <Press key={v} className="dk-col" data-on={cols === v || undefined} aria-pressed={cols === v} onPress={() => setCols(v)}>
              {v === 0 ? 'Auto' : v}
            </Press>
          ))}
        </div>
      </div>

      <div ref={stageRef} className="dk-stage">
        {n === 0 && !picker && (
          <div className="dk-empty">
            <p>No sessions on the desk.</p>
            <Press className="dk-add" onPress={() => setPicker(true)}>+ Session</Press>
          </div>
        )}

        {n > 0 && (
          <div className="dk-grid" style={{ gridTemplateColumns: `repeat(${c}, minmax(0, 1fr))` }}>
            {panes.map((name) => {
              const s = byName.get(name)
              const gone = sessions.isSuccess && !sessions.isFetching && !s
              return (
                <section key={name} className="dk-pane" data-gone={gone || undefined}>
                  <header className="dk-pane-bar">
                    <span className="dk-pane-name vl-ellipsis">{s ? termLabel(s, titles) : name}</span>
                    {gone && <span className="dk-pane-state">Not open</span>}
                    <Press className="dk-pane-act" onPress={() => navigate(v2TermPath(name))}>Full</Press>
                    <Press className="dk-pane-act" onPress={() => hide(name)}>Hide</Press>
                  </header>
                  <iframe
                    ref={(el) => { if (el) frames.current.set(name, el); else frames.current.delete(name) }}
                    className="dk-frame"
                    title={s ? termLabel(s, titles) : name}
                    src={`/m/w/term/${encodeURIComponent(name)}`}
                  />
                </section>
              )
            })}
          </div>
        )}

        {picker && (
          <Picker
            shown={new Set(panes)}
            sessions={sessions.data ?? EMPTY}
            titles={titles}
            grid={grid}
            onPick={add}
            onClose={() => setPicker(false)}
          />
        )}
      </div>
    </div>
  )
}

// What goes on the desk: a session already open, a new Claude session or a
// shell in any launch target on thor, or a conversation from the board.
function Picker({ shown, sessions, titles, grid, onPick, onClose }: {
  shown: Set<string>
  sessions: TermSession[]
  titles: Map<string, string>
  grid: () => { cols: number; rows: number }
  onPick: (name: string) => void
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [kind, setKind] = useState<'new' | 'shell'>('new')
  const targets = useQuery({ queryKey: ['launchTargets', 'thor'], queryFn: () => fetchLaunchTargets('thor'), staleTime: 60_000 })
  const board = useQuery({ queryKey: ['sessionList'], queryFn: fetchSessionList, staleTime: 10_000 })

  const open = sessions.filter((s) => !shown.has(s.name) && !s.dead)
  // the phone's favorites lead, as on every other picker
  const launch = [...(targets.data ?? [])].filter((t) => t.exists).sort((a, b) => Number(b.phone) - Number(a.phone))
  const resumable = board.data?.installed ? board.data.sessions.filter((s) => !s.live && !s.done).slice(0, 30) : []

  const start = async (body: TermOpen) => {
    setBusy(true)
    try {
      const data = await openTermSession({ ...body, ...grid() })
      await qc.invalidateQueries({ queryKey: ['term', 'sessions'] })
      if (data.name) onPick(data.name)
    } catch (e) {
      toast(`Could not open it: ${errText(e)}`, { ms: 5000 })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dk-pick">
      <div className="dk-pick-in">
        <div className="dk-pick-head">
          <h2>Add to the desk</h2>
          <Press className="dk-pane-act" onPress={onClose}>Close</Press>
        </div>

        <section>
          <h3 className="dk-k">Open now <span className="dk-n">{open.length}</span></h3>
          {open.length === 0 && <p className="dk-quiet">{sessions.length ? 'Everything open is on the desk.' : 'No session is open.'}</p>}
          <div className="dk-rows">
            {open.map((s) => (
              <Press key={s.name} className="dk-row" onPress={() => onPick(s.name)}>
                <span className="dk-row-main vl-ellipsis">{termLabel(s, titles)}</span>
                <span className="dk-row-meta">{s.mode === 'shell' ? 'Shell' : 'Claude'} · {s.host}</span>
              </Press>
            ))}
          </div>
        </section>

        <section>
          <div className="dk-k-row">
            <h3 className="dk-k">Start on thor</h3>
            <div className="dk-cols" role="group" aria-label="What to start">
              <Press className="dk-col" data-on={kind === 'new' || undefined} onPress={() => setKind('new')}>Claude</Press>
              <Press className="dk-col" data-on={kind === 'shell' || undefined} onPress={() => setKind('shell')}>Shell</Press>
            </div>
          </div>
          {targets.isLoading && <p className="dk-quiet">Asking thor what it can start</p>}
          {targets.isError && <p className="dk-quiet">Could not reach thor: {errText(targets.error)}</p>}
          {targets.isSuccess && launch.length === 0 && <p className="dk-quiet">thor offers no launch targets. It may be asleep.</p>}
          <div className="dk-chips">
            {launch.map((t) => (
              <Press
                key={t.key}
                className="dk-chip"
                disabled={busy}
                onPress={() => void start(kind === 'new'
                  ? { mode: 'new', target: t.key, label: t.label }
                  : { mode: 'shell', target: t.key, label: `${t.label} sh` })}
              >
                {t.label}
              </Press>
            ))}
          </div>
        </section>

        <section>
          <h3 className="dk-k">Resume from the board <span className="dk-n">{resumable.length}</span></h3>
          {board.data && !board.data.installed && <p className="dk-quiet">The session board answered {board.data.status}. thor may be asleep.</p>}
          <div className="dk-rows">
            {resumable.map((r) => (
              <Press
                key={r.sessionId}
                className="dk-row"
                disabled={busy}
                onPress={() => void start({ mode: 'resume', sessionId: r.sessionId, label: r.title })}
              >
                <span className="dk-row-main vl-ellipsis">{r.title}</span>
                <span className="dk-row-meta">{r.project}</span>
              </Press>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
