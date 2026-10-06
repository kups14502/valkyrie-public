import { useEffect, useState, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ArrowRight, Check, Pencil, Trash2, X } from 'lucide-react'
import { apiErrorText } from '../../lib/api'
import { LIMITS, PROJ_KEYS, moveProjTab, removeProjTab, updateProjTab, type Tab } from '../../lib/projectsApi'
import { BTN_GHOST, BTN_TEXT, FIELD } from './Sheet'

// One click arms it for four seconds and a second click fires. Every removal on
// a project page is undoable from the activity tab, but a mis-tap on a phone
// should still cost nothing.
export function ArmButton({ label, armedLabel, onConfirm, disabled, title, icon }: {
  label: string
  armedLabel?: string
  onConfirm: () => void
  disabled?: boolean
  title?: string
  icon?: ReactNode
}) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(t)
  }, [armed])

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        if (!armed) return setArmed(true)
        setArmed(false)
        onConfirm()
      }}
      title={armed ? 'Click again to confirm' : title}
      className={`inline-flex min-h-9 items-center gap-1.5 border px-2 text-[10px] uppercase tracking-[0.1em] transition disabled:opacity-30 ${armed
        ? 'border-[var(--color-danger)] bg-[var(--color-danger)]/10 text-[var(--color-danger)]'
        : 'border-transparent text-[var(--color-text-faint)] hover:text-[var(--color-danger)]'}`}
    >
      {icon}
      {armed ? (armedLabel ?? `${label}?`) : label}
    </button>
  )
}

export function TabTools({ projectId, tab, index, count, onEdit }: {
  projectId: string
  tab: Tab
  index: number
  count: number
  onEdit?: () => void
}) {
  const qc = useQueryClient()
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState(tab.title)
  const [error, setError] = useState('')

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: PROJ_KEYS.doc(projectId) })
    void qc.invalidateQueries({ queryKey: PROJ_KEYS.events(projectId) })
  }
  const rename = useMutation({
    mutationFn: (next: string) => updateProjTab(projectId, tab.id, { baseRev: tab.rev, title: next }),
    onSuccess: () => { setRenaming(false); setError(''); refresh() },
    onError: (e: unknown) => setError(apiErrorText(e, 'could not rename it')),
  })
  const move = useMutation({
    mutationFn: (toIndex: number) => moveProjTab(projectId, tab.id, toIndex),
    onSuccess: () => { setError(''); refresh() },
    onError: (e: unknown) => setError(apiErrorText(e, 'could not move it')),
  })
  // The page falls back to the sessions tab on its own: ?tab= then names a tab
  // that is no longer in the doc.
  const remove = useMutation({
    mutationFn: () => removeProjTab(projectId, tab.id),
    onSuccess: () => { setError(''); refresh() },
    onError: (e: unknown) => setError(apiErrorText(e, 'could not remove it')),
  })

  const submitRename = () => {
    const next = title.trim()
    if (!next || next === tab.title) return setRenaming(false)
    rename.mutate(next)
  }
  const busy = rename.isPending || move.isPending || remove.isPending

  return (
    <div className="mb-3">
      <div className="flex flex-wrap items-center justify-end gap-1">
        {tab.updatedBy.startsWith('session:') && (
          <span className="mr-auto text-[10px] text-[var(--color-text-faint)]">[by session]</span>
        )}
        {renaming ? (
          <form
            className="flex min-w-0 flex-1 items-center gap-1 sm:flex-none"
            onSubmit={(e) => { e.preventDefault(); submitRename() }}
          >
            <input
              autoFocus
              value={title}
              maxLength={LIMITS.tabTitle}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') setRenaming(false) }}
              aria-label="Tab title"
              className={`flex-1 sm:w-56 ${FIELD}`}
            />
            <button type="submit" disabled={rename.isPending} className={BTN_TEXT} aria-label="Save the title">
              <Check size={12} />
            </button>
            <button type="button" onClick={() => setRenaming(false)} className={BTN_TEXT} aria-label="Cancel renaming">
              <X size={12} />
            </button>
          </form>
        ) : (
          <>
            {onEdit && (
              <button
                type="button"
                onClick={onEdit}
                className={BTN_GHOST}
              >
                <Pencil size={11} /> edit
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => { setTitle(tab.title); setRenaming(true) }}
              className={BTN_TEXT}
            >
              rename
            </button>
          </>
        )}
        <button
          type="button"
          disabled={busy || index <= 0}
          onClick={() => move.mutate(index - 1)}
          aria-label="Move this tab left"
          title="Move this tab left"
          className={BTN_TEXT}
        >
          <ArrowLeft size={12} />
        </button>
        <button
          type="button"
          disabled={busy || index < 0 || index >= count - 1}
          onClick={() => move.mutate(index + 1)}
          aria-label="Move this tab right"
          title="Move this tab right"
          className={BTN_TEXT}
        >
          <ArrowRight size={12} />
        </button>
        <ArmButton
          label="remove"
          armedLabel="remove tab?"
          icon={<Trash2 size={11} />}
          disabled={busy}
          title="Remove this tab. The activity tab can undo it."
          onConfirm={() => remove.mutate()}
        />
      </div>
      {error && <div className="mt-1 text-right text-[11px] text-[var(--color-danger)]">{error}</div>}
    </div>
  )
}
