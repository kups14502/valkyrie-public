import { useCallback, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { apiErrorText, openTermSession, termPath, type TermSession } from '../../lib/api'
import { useProfile } from '../../lib/deviceMode'
import { TERM_NAME_RE } from '../../lib/term'
import { PROJ_KEYS, isChangedSince, type Project, type ProjectTerm } from '../../lib/projectsApi'
import { seedTerminal } from '../../lib/sessionLaunch'
import type { TermConn, TermPaneApi } from '../TermPane'

// Tailwind's lg. The column layout and this flag must flip at the same width,
// or the page would lay out for a terminal it is not rendering.
const WIDE = '(min-width: 1024px)'
const subscribeWide = (cb: () => void) => {
  const mq = window.matchMedia(WIDE)
  mq.addEventListener('change', cb)
  return () => mq.removeEventListener('change', cb)
}
const wideNow = () => window.matchMedia(WIDE).matches

// Rough cell size of the JetBrains Mono stack: 0.6em wide, 1.32em tall with
// xterm's line height. Only the first frame uses it; TermPane fits the real
// grid as soon as the socket opens.
const CELL_W = 0.6
const CELL_H = 1.32

export type ProjectTermState = ProjectTerm & {
  conn: TermConn
  setConn: (c: TermConn) => void
  setApi: (a: TermPaneApi | null) => void
  deselect: () => void
  dismissError: () => void
}

export function useProjectTerm(
  projectId: string,
  project: Project | undefined,
  paneRef: RefObject<HTMLElement | null>,
): ProjectTermState {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const wide = useSyncExternalStore(subscribeWide, wideNow)
  const embedded = useProfile().resolved === 'desktop' && wide
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conn, setConn] = useState<TermConn>('connecting')
  const apiRef = useRef<TermPaneApi | null>(null)
  // Two taps on "new session" before the first answer would be two sessions.
  const inFlight = useRef(false)

  const back = `/projects/${projectId}`
  const raw = params.get('term')
  const selected = embedded && raw && TERM_NAME_RE.test(raw) ? raw : null

  const setTermParam = useCallback((name: string | null) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (name) next.set('term', name)
      else next.delete('term')
      return next
    }, { replace: true })
  }, [setParams])

  const open = useCallback((name: string) => {
    if (embedded) setTermParam(name)
    else navigate(termPath(name, back))
  }, [embedded, setTermParam, navigate, back])

  const grid = () => {
    let cols: number
    let rows: number
    const box = paneRef.current
    if (embedded && box) {
      cols = Math.floor(box.clientWidth / (13 * CELL_W))
      rows = Math.floor(box.clientHeight / (13 * CELL_H))
    } else if (embedded) {
      // The pane mounts only once a session is open in it: guess its box from
      // the middle column it is about to take, between the two side columns.
      cols = Math.floor(Math.max(480, window.innerWidth - 720) / (13 * CELL_W))
      rows = Math.floor((window.innerHeight - 260) / (13 * CELL_H))
    } else {
      // The pinned phone terminal loses about 120px to its header and key bar.
      cols = Math.floor(window.innerWidth / (12 * CELL_W))
      rows = Math.floor((window.innerHeight - 120) / (12 * CELL_H))
    }
    return { cols: Math.max(24, cols), rows: Math.max(10, rows) }
  }

  const run = async (fn: () => Promise<void>) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      // The run sheet shows a changed brief itself, with the new text.
      if (isChangedSince(e)) throw e
      // Verbatim: the backend's 409 at the session cap says what to close.
      setError(apiErrorText(e, 'could not open a session'))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const resume = (sessionId: string, title?: string) => run(async () => {
    // Already in a pane: go to it. A second resume of a running conversation
    // is a second Claude writing the same transcript.
    const terms = qc.getQueryData<TermSession[]>(['term', 'sessions']) ?? []
    const hit = terms.find((t) => !t.dead && (t.sessionId === sessionId || (t.mode === 'resume' && t.target === sessionId)))
    if (hit) {
      open(hit.name)
      return
    }
    const r = await openTermSession({ mode: 'resume', sessionId, project: projectId, label: title, ...grid() })
    seedTerminal(qc, r)
    void qc.invalidateQueries({ queryKey: PROJ_KEYS.doc(projectId) })
    open(r.name)
  })

  // No label: the backend names a plain session after the project and a run
  // "<project>: <run name>", which is the only way a run's chip stands out.
  const start = (opts?: { automation?: string; automationRev?: number }) => run(async () => {
    if (!project) throw new Error('project not loaded')
    const r = await openTermSession({
      mode: 'new', project: projectId, automation: opts?.automation, automationRev: opts?.automationRev, ...grid(),
    })
    seedTerminal(qc, r)
    void qc.invalidateQueries({ queryKey: PROJ_KEYS.doc(projectId) })
    open(r.name)
  })

  const setApi = useCallback((a: TermPaneApi | null) => { apiRef.current = a }, [])

  return {
    embedded,
    selected,
    canSend: embedded && selected !== null && conn === 'live',
    send: (text: string) => apiRef.current?.send(text),
    open,
    resume,
    start,
    busy,
    error,
    conn,
    setConn,
    setApi,
    deselect: () => setTermParam(null),
    dismissError: () => setError(null),
  }
}
