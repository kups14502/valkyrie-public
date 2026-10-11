import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  apiErrorText, fetchLaunchTargets, localHostname, openNewSessionHere, openTermSession, startSessionOnHost,
  termPath, type LaunchTarget,
} from './api'
import { readOpenMode, seedTerminal } from './sessionLaunch'

// One tap to a new Claude session of each kind, shared by the phone home row
// (components/QuickSessions) and the desktop dashboard's status line. The
// kinds are thor's phone targets, less the ones Add-LaunchTarget made for a
// single project: those start from their project. Where the session opens
// follows the session board: a browser and the phone get the in-page
// terminal, the desktop app obeys the board's "in page / on screen" toggle.

const HOST = 'thor'

// A label can carry a note in brackets, which suits a menu; a button needs the kind.
export const shortName = (t: LaunchTarget) => t.label.replace(/\s*\(.*\)\s*$/, '') || t.key

/** The session kinds and the start action, shared by the phone row and the dashboard. */
export function useQuickSessions() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null)
  const [here, setHere] = useState<string | null>(null)

  useEffect(() => { void localHostname().then(setHere) }, [])
  useEffect(() => {
    if (!note || note.error) return
    const t = setTimeout(() => setNote(null), 6_000)
    return () => clearTimeout(t)
  }, [note])

  // Same key and shape as the board's and the terminal page's, so all three
  // share one cache entry.
  const targets = useQuery({ queryKey: ['launchTargets', HOST], queryFn: () => fetchLaunchTargets(HOST), staleTime: 60_000 })
  const kinds = (targets.data ?? []).filter((t) => t.phone && t.exists && !t.project)

  const start = async (t: LaunchTarget) => {
    setBusy(t.key); setNote(null)
    try {
      if (readOpenMode() === 'page') {
        const r = await openTermSession({ mode: 'new', target: t.key, label: t.label })
        seedTerminal(qc, r)
        navigate(termPath(r.name))
        return
      }
      // On screen means the screen in front of Brendon: the desktop app off thor
      // opens the terminal itself and SSHes in; on thor the agent opens the tab.
      if (here !== null && here !== HOST) {
        await openNewSessionHere(t.key, undefined, t.group)
        setNote({ text: `${shortName(t)} opened here`, error: false })
      } else {
        const r = await startSessionOnHost(HOST, t.key)
        if (!r.ok) throw new Error(r.detail ?? 'could not start it')
        setNote({ text: `${shortName(t)} opened on ${HOST}`, error: false })
      }
      // Claude takes a moment to register, so give the session list something to find.
      setTimeout(() => void qc.invalidateQueries({ queryKey: ['sessionList'] }), 2_500)
    } catch (e) {
      setNote({ text: apiErrorText(e, (e as Error).message || 'could not start it'), error: true })
    } finally {
      setBusy(null)
    }
  }

  // A sleeping thor answers no targets, and a row of nothing is worse than no row.
  const empty = targets.isSuccess && kinds.length === 0
  return { kinds, loading: targets.isLoading, empty, busy, note, start }
}
