import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { apiErrorText } from '../../lib/api'
import { LIMITS, PROJ_KEYS, addProjTab, type ProjectDoc, type TabKind } from '../../lib/projectsApi'
import { BTN_ACCENT, BTN_GHOST, FIELD, LABEL, Sheet } from './Sheet'

const KINDS: TabKind[] = ['markdown', 'checklist', 'links']

export function AddTabSheet({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const qc = useQueryClient()
  const [, setParams] = useSearchParams()
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState<TabKind>('markdown')
  const [error, setError] = useState('')

  const add = useMutation({
    mutationFn: () => addProjTab(projectId, { kind, title: title.trim() }),
    onSuccess: (tab) => {
      // Into the cached doc first: selecting an id the tab bar has not heard of
      // yet would show the sessions tab until the refetch lands.
      qc.setQueryData<ProjectDoc>(PROJ_KEYS.doc(projectId), (d) => (d ? { ...d, tabs: [...d.tabs, tab] } : d))
      void qc.invalidateQueries({ queryKey: PROJ_KEYS.doc(projectId) })
      void qc.invalidateQueries({ queryKey: PROJ_KEYS.events(projectId) })
      setParams((prev) => {
        const next = new URLSearchParams(prev)
        next.set('tab', tab.id)
        return next
      }, { replace: true })
      onClose()
    },
    onError: (e: unknown) => setError(apiErrorText(e, 'could not add the tab')),
  })

  const ready = title.trim() !== '' && !add.isPending

  return (
    <Sheet
      title="new tab"
      onClose={onClose}
      footer={(
        <>
          <button type="button" disabled={!ready} onClick={() => add.mutate()} className={BTN_ACCENT}>
            <Plus size={13} /> {add.isPending ? 'adding' : 'add tab'}
          </button>
          <button type="button" onClick={onClose} className={BTN_GHOST}>cancel</button>
        </>
      )}
    >
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (ready) add.mutate() }}>
        <label className="block">
          <span className={LABEL}>title</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={LIMITS.tabTitle}
            autoFocus
            className={FIELD}
          />
        </label>
        <div>
          <span className={LABEL}>kind</span>
          <div className="flex flex-wrap gap-2">
            {KINDS.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                aria-pressed={kind === k}
                className={`min-h-10 border px-3 text-[10px] uppercase tracking-[0.18em] transition ${
                  kind === k
                    ? 'border-[var(--color-accent)]/70 bg-[rgba(var(--color-accent-rgb),0.12)] text-[var(--color-accent)]'
                    : 'border-[var(--color-border)] text-[var(--color-text-dim)] hover:text-[var(--color-text)]'
                }`}
              >
                {k}
              </button>
            ))}
          </div>
        </div>
        {error && <div className="text-xs text-[var(--color-danger)]">{error}</div>}
      </form>
    </Sheet>
  )
}
