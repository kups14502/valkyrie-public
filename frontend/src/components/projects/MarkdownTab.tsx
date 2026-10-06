import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiErrorText } from '../../lib/api'
import { LIMITS, PROJ_KEYS, updateProjTab, type CustomTabProps, type ProjectDoc, type Tab } from '../../lib/projectsApi'
import { Markdown } from '../Markdown'
import { BTN_ACCENT, BTN_GHOST, FIELD } from './Sheet'
import { TabTools } from './TabTools'

// A stale baseRev comes back as 409 with the tab as it is now.
const conflictTab = (e: unknown): Tab | null => {
  const r = (e as { response?: { status?: number; data?: { current?: Tab } } } | null)?.response
  return r?.status === 409 && r.data?.current ? r.data.current : null
}

type Edit = { draft: string; baseRev: number }

// Open drafts by `${projectId}:${tabId}`, outside any component. The page
// mounts only the active tab, and on the phone a session opens by navigating
// away from the page, so a draft held in state was dropped by either one. It
// lives as long as the app does, not across a reload. A baseRev gone stale in
// the meantime still comes back as a 409.
const drafts = new Map<string, Edit>()

// Keyed on the tab, so switching between two markdown tabs never carries a
// draft from one into the other when the page reuses this component.
export function MarkdownTab(p: CustomTabProps) {
  return <MarkdownTabBody key={p.tab.id} {...p} />
}

function MarkdownTabBody({ projectId, doc, tab }: CustomTabProps) {
  const qc = useQueryClient()
  // The draft and the rev it was taken from live only here and in `drafts`.
  // The doc keeps polling underneath, and a session can rewrite this tab at
  // any moment, so nothing from the poll may land in the box while it is open.
  const draftKey = `${projectId}:${tab.id}`
  const [edit, setEditState] = useState<Edit | null>(() => drafts.get(draftKey) ?? null)
  const setEdit = (next: Edit | null) => {
    if (next) drafts.set(draftKey, next)
    else drafts.delete(draftKey)
    setEditState(next)
  }
  const [conflict, setConflict] = useState<Tab | null>(null)
  const [error, setError] = useState('')

  const save = useMutation({
    mutationFn: ({ baseRev, body }: { baseRev: number; body: string }) =>
      updateProjTab(projectId, tab.id, { baseRev, body }),
    onSuccess: (saved: Tab) => {
      // The reply is the saved tab. Put it in the cached doc now, or the view
      // shows the old body until the refetch below lands.
      qc.setQueryData<ProjectDoc>(PROJ_KEYS.doc(projectId), (old) =>
        old && { ...old, tabs: old.tabs.map((t) => (t.id === saved.id ? saved : t)) })
      setEdit(null); setConflict(null); setError('')
      void qc.invalidateQueries({ queryKey: PROJ_KEYS.doc(projectId) })
      void qc.invalidateQueries({ queryKey: PROJ_KEYS.events(projectId) })
    },
    onError: (e: unknown) => {
      const current = conflictTab(e)
      if (current) { setConflict(current); setError(''); return }
      setError(apiErrorText(e, 'could not save the note'))
    },
  })

  const index = doc.tabs.findIndex((t) => t.id === tab.id)

  if (!edit) {
    return (
      <div>
        <TabTools
          projectId={projectId}
          tab={tab}
          index={index}
          count={doc.tabs.length}
          onEdit={() => { setEdit({ draft: tab.body, baseRev: tab.rev }); setConflict(null); setError('') }}
        />
        <Markdown>{tab.body || '_empty, ask a session to fill it_'}</Markdown>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {conflict && (
        <div className="space-y-2 border border-[var(--color-warning)]/50 px-3 py-2 text-xs text-[var(--color-warning)]">
          <div>
            changed while you were editing
            {conflict.updatedBy.startsWith('session:') ? ' (by a session)' : ''}. Your draft is still below.
          </div>
          <details>
            <summary className="cursor-pointer text-[11px] uppercase tracking-[0.14em]">the newer version</summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words border border-[var(--color-border)] p-2 text-[12px] text-[var(--color-text-dim)]">
              {conflict.body || '(empty)'}
            </pre>
          </details>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={save.isPending}
              onClick={() => save.mutate({ baseRev: conflict.rev, body: edit.draft })}
              className={BTN_ACCENT}
            >
              save mine anyway
            </button>
            <button
              type="button"
              disabled={save.isPending}
              onClick={() => { setEdit({ draft: conflict.body, baseRev: conflict.rev }); setConflict(null) }}
              className={BTN_GHOST}
            >
              discard mine
            </button>
          </div>
        </div>
      )}
      <textarea
        autoFocus
        value={edit.draft}
        maxLength={LIMITS.tabBody}
        onChange={(e) => setEdit({ ...edit, draft: e.target.value })}
        aria-label={`Edit ${tab.title}`}
        className={`min-h-[45dvh] resize-y ${FIELD}`}
      />
      {error && <div className="text-xs text-[var(--color-danger)]">{error}</div>}
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={save.isPending || conflict !== null}
          onClick={() => save.mutate({ baseRev: edit.baseRev, body: edit.draft })}
          className={BTN_ACCENT}
        >
          {save.isPending ? 'saving' : 'save'}
        </button>
        <button
          type="button"
          disabled={save.isPending}
          onClick={() => { setEdit(null); setConflict(null); setError('') }}
          className={BTN_GHOST}
        >
          cancel
        </button>
        <span className="text-[11px] text-[var(--color-text-faint)]">Markdown. Raw HTML is not shown.</span>
      </div>
    </div>
  )
}
