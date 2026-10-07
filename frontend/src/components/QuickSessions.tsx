import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import {
  apiErrorText, fetchLaunchTargets, localHostname, openNewSessionHere, openTermSession, startSessionOnHost,
  termPath, type LaunchTarget,
} from '../lib/api'
import { readOpenMode, seedTerminal } from '../lib/sessionLaunch'

// One tap to a new Claude session of each kind, from the desktop dashboard and
// the phone home. The kinds are thor's phone targets, less the ones
// Add-LaunchTarget made for a single project: those start from their project.
// Where the session opens follows the session board: a browser and the phone
// get the in-page terminal, the desktop app obeys the board's "in page / on
// screen" toggle.

const HOST = 'thor'

// A label can carry a note in brackets, which suits a menu; a button needs the kind.
const shortName = (t: LaunchTarget) => t.label.replace(/\s*\(.*\)\s*$/, '') || t.key

export function QuickSessions() {
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

  // A sleeping thor answers no targets, and a row of nothing is worse than no row.
  if (targets.isSuccess && kinds.length === 0) return null

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

  // vk-compact: lets the small text sizes on these buttons apply (index.css).
  return (
    <section className="vk-compact border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="w-full text-[10px] font-bold uppercase tracking-[0.2em] text-[var(--color-accent)] sm:w-auto">// new claude</span>
        <div className="grid flex-1 grid-cols-3 gap-2 sm:flex sm:flex-none sm:flex-wrap">
          {targets.isLoading ? (
            <span className="col-span-3 text-[11px] text-[var(--color-text-faint)]">reading thor…</span>
          ) : kinds.map((t) => (
            <button
              key={t.key}
              type="button"
              disabled={busy !== null}
              onClick={() => void start(t)}
              title={`Start a new Claude session in ${t.label}`}
              className="inline-flex min-h-11 items-center justify-center gap-1.5 border border-[var(--color-border-strong)] px-3 text-[12px] text-[var(--color-text)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] active:border-[var(--color-accent)] active:text-[var(--color-accent)] disabled:opacity-40 sm:min-h-8 sm:text-[11px]"
            >
              {/* A third of a phone has no room for it: the longest name crushed it. */}
              <Plus size={12} className="hidden shrink-0 sm:block" /> {busy === t.key ? 'starting…' : shortName(t)}
            </button>
          ))}
        </div>
        {note && (
          <span className={`text-[11px] ${note.error ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-faint)]'}`}>{note.text}</span>
        )}
      </div>
    </section>
  )
}
