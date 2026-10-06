import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link2 } from 'lucide-react'
import { apiErrorText, fetchSessionList } from '../../lib/api'
import { PROJ_KEYS, unlinkProjSession, type ProjectTabProps } from '../../lib/projectsApi'
import { SessionBoard } from '../SessionBoard'
import { AddSessionSheet } from './AddSessionSheet'
import { BTN_TEXT } from './Sheet'

export function SessionsTab({ projectId, doc, term }: ProjectTabProps) {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')
  const board = useQuery({ queryKey: ['sessionList'], queryFn: fetchSessionList })

  const sessionIds = useMemo(() => new Set(doc.sessions.map((s) => s.sessionId)), [doc.sessions])
  const notes = useMemo(() => {
    const titles = new Map<string, string>()
    for (const s of (board.data?.installed ? board.data.sessions : [])) titles.set(s.sessionId, s.title)
    return doc.sessions
      .filter((s) => s.statusNote)
      .map((s) => ({ id: s.sessionId, text: `${titles.get(s.sessionId) ?? s.sessionId.slice(0, 8)}: ${s.statusNote}` }))
  }, [doc.sessions, board.data])

  const unlink = (sessionId: string) => {
    setError('')
    unlinkProjSession(projectId, sessionId)
      .then(() => {
        void qc.invalidateQueries({ queryKey: PROJ_KEYS.doc(projectId) })
        void qc.invalidateQueries({ queryKey: PROJ_KEYS.list })
      })
      .catch((e: unknown) => setError(apiErrorText(e, 'could not unlink that session')))
  }

  return (
    <div className="space-y-3">
      {error && <div className="text-xs text-[var(--color-danger)]">{error}</div>}

      <SessionBoard scope={{ projectId, sessionIds, onUnlink: unlink }} onOpenTerminal={term.open} />

      {notes.length > 0 && (
        <div className="space-y-0.5 border-t border-[var(--color-border)] pt-2 text-[11px] text-[var(--color-text-faint)]">
          {notes.map((n) => <div key={n.id} className="break-words">{n.text}</div>)}
        </div>
      )}

      <button type="button" onClick={() => setAdding(true)} className={BTN_TEXT}>
        <Link2 size={11} /> link an existing session
      </button>

      {adding && <AddSessionSheet projectId={projectId} doc={doc} onClose={() => setAdding(false)} />}
    </div>
  )
}
