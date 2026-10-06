import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Bell, X } from 'lucide-react'
import { apiErrorText } from '../../lib/api'
import {
  LIMITS, PROJ_KEYS, addProjReminder, cancelProjReminder,
  type ProjectTabProps, type Reminder,
} from '../../lib/projectsApi'
import { ArmButton } from './TabTools'
import { BTN_ACCENT, FIELD, LABEL } from './Sheet'

const when = (iso: string): string =>
  new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

// Both directions: pending reminders are in the future, the rest in the past.
const relative = (iso: string): string => {
  const ms = Date.parse(iso) - Date.now()
  if (!Number.isFinite(ms)) return ''
  const m = Math.round(Math.abs(ms) / 60_000)
  const span = m < 1 ? 'now' : m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`
  if (span === 'now') return 'now'
  return ms > 0 ? `in ${span}` : `${span} ago`
}

function PendingRow({ projectId, r }: { projectId: string; r: Reminder }) {
  const qc = useQueryClient()
  const [error, setError] = useState('')
  const cancel = useMutation({
    mutationFn: () => cancelProjReminder(projectId, r.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: PROJ_KEYS.doc(projectId) })
      void qc.invalidateQueries({ queryKey: PROJ_KEYS.events(projectId) })
    },
    onError: (e: unknown) => setError(apiErrorText(e, 'could not cancel it')),
  })
  return (
    <li className={`flex flex-wrap items-start gap-x-3 gap-y-1 py-2.5${cancel.isPending ? ' opacity-40' : ''}`}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
          <span className="text-[var(--color-text)]">{when(r.at)}</span>
          <span className="text-[var(--color-accent)]">{relative(r.at)}</span>
          {r.createdBy.startsWith('session:') && <span className="text-[10px] text-[var(--color-text-faint)]">[by session]</span>}
        </div>
        <div className="mt-0.5 whitespace-pre-wrap break-words text-sm text-[var(--color-text-dim)]">{r.message}</div>
        {error && <div className="mt-1 text-[11px] text-[var(--color-danger)]">{error}</div>}
      </div>
      <ArmButton
        label="cancel"
        armedLabel="cancel it?"
        icon={<X size={11} />}
        disabled={cancel.isPending}
        title="Cancel this reminder"
        onConfirm={() => cancel.mutate()}
      />
    </li>
  )
}

export function RemindersTab({ projectId, doc }: ProjectTabProps) {
  const qc = useQueryClient()
  const [at, setAt] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const pending = doc.reminders.filter((r) => r.state === 'pending').sort((a, b) => a.at.localeCompare(b.at))
  const rest = doc.reminders.filter((r) => r.state !== 'pending').sort((a, b) => b.at.localeCompare(a.at))
  const full = pending.length >= LIMITS.pendingReminders

  // datetime-local has no zone. new Date() reads it as this device's local
  // time, and toISOString sends it with the Z the backend insists on, so a
  // reminder set on the phone fires at the hour the phone showed.
  const atMs = at ? new Date(at).getTime() : NaN
  const ready = Number.isFinite(atMs) && message.trim() !== '' && !full

  const add = useMutation({
    mutationFn: () => addProjReminder(projectId, { at: new Date(at).toISOString(), message: message.trim() }),
    onSuccess: () => {
      setAt(''); setMessage(''); setError('')
      void qc.invalidateQueries({ queryKey: PROJ_KEYS.doc(projectId) })
      void qc.invalidateQueries({ queryKey: PROJ_KEYS.events(projectId) })
    },
    onError: (e: unknown) => setError(apiErrorText(e, 'could not add the reminder')),
  })

  return (
    <div className="space-y-5">
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (ready) add.mutate() }}>
        <label className="block">
          <span className={LABEL}>when</span>
          <input
            type="datetime-local"
            value={at}
            onChange={(e) => setAt(e.target.value)}
            className={`sm:w-64 ${FIELD}`}
          />
        </label>
        <label className="block">
          <span className={LABEL}>message</span>
          <textarea
            value={message}
            maxLength={LIMITS.reminderMessage}
            onChange={(e) => setMessage(e.target.value)}
            rows={3}
            placeholder={full ? `${LIMITS.pendingReminders} pending is the most a project holds` : 'what to remember'}
            disabled={full}
            className={`resize-y ${FIELD}`}
          />
        </label>
        {error && <div className="text-xs text-[var(--color-danger)]">{error}</div>}
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={!ready || add.isPending} className={BTN_ACCENT}>
            <Bell size={12} /> {add.isPending ? 'adding' : 'add reminder'}
          </button>
          <span className="text-[11px] text-[var(--color-text-faint)]">
            Outside personal and server, the DM is a generic text; the full text stays here.
          </span>
        </div>
      </form>

      <div>
        <div className="mb-1 text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-faint)]">
          pending <span className="text-[var(--color-border-strong)]">{pending.length}</span>
        </div>
        {pending.length === 0 ? (
          <div className="py-2 text-[11px] text-[var(--color-text-faint)]">Nothing scheduled.</div>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {pending.map((r) => <PendingRow key={r.id} projectId={projectId} r={r} />)}
          </ul>
        )}
      </div>

      {rest.length > 0 && (
        <div className="opacity-60">
          <div className="mb-1 text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-faint)]">
            last 30 days <span className="text-[var(--color-border-strong)]">{rest.length}</span>
          </div>
          <ul className="divide-y divide-[var(--color-border)]">
            {rest.map((r) => (
              <li key={r.id} className="py-2">
                <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
                  <span className={r.state === 'failed' ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-faint)]'}>[{r.state}]</span>
                  <span className="text-[var(--color-text-dim)]">{when(r.at)}</span>
                  <span className="text-[var(--color-text-faint)]">{relative(r.at)}</span>
                </div>
                <div className="mt-0.5 whitespace-pre-wrap break-words text-xs text-[var(--color-text-dim)]">{r.message}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
