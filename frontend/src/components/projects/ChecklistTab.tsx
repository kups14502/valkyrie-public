import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, Pencil, Plus, X } from 'lucide-react'
import { apiErrorText } from '../../lib/api'
import {
  LIMITS, PROJ_KEYS, projTabItem,
  type ChecklistItem, type CustomTabProps, type TabItemOp,
} from '../../lib/projectsApi'
import { BTN_ACCENT, FIELD } from './Sheet'
import { TabTools } from './TabTools'

const ICON = 'inline-flex min-h-9 shrink-0 items-center border border-transparent px-2 text-[var(--color-text-faint)] transition disabled:opacity-30'

// One mutation per row so a toggle on one item never shows as pending on
// another. onSuccess returns the refetch, which keeps the row pending (and
// drawn in its new state from the variables) until the doc has caught up, so
// a tick never flickers back for one poll.
function useItemOp(projectId: string, tabId: string, onError: (msg: string) => void, fallback: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (op: TabItemOp) => projTabItem(projectId, tabId, op),
    onSuccess: () => Promise.all([
      qc.invalidateQueries({ queryKey: PROJ_KEYS.doc(projectId) }),
      qc.invalidateQueries({ queryKey: PROJ_KEYS.events(projectId) }),
    ]),
    onError: (e: unknown) => onError(apiErrorText(e, fallback)),
  })
}

function ItemRow({ projectId, tabId, item, onError }: {
  projectId: string
  tabId: string
  item: ChecklistItem
  onError: (msg: string) => void
}) {
  const op = useItemOp(projectId, tabId, onError, 'could not change that item')
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(item.text)

  const pending = op.isPending ? op.variables : undefined
  const done = pending?.op === 'set' ? pending.done : item.done
  const removing = pending?.op === 'remove'

  const startEdit = () => { setText(item.text); setEditing(true) }
  const submitEdit = () => {
    const next = text.trim()
    setEditing(false)
    if (next && next !== item.text) op.mutate({ op: 'edit', itemId: item.id, text: next })
  }

  return (
    <li className={`flex items-center gap-2 border-b border-[var(--color-border)] py-1 last:border-b-0${removing ? ' opacity-40' : ''}`}>
      <button
        type="button"
        role="checkbox"
        aria-checked={done}
        aria-label={done ? `Mark "${item.text}" open` : `Mark "${item.text}" done`}
        disabled={op.isPending}
        onClick={() => op.mutate({ op: 'set', itemId: item.id, done: !done })}
        // The padding is the hit area, so a 16px box is a 36px target.
        className="flex min-h-9 shrink-0 items-center justify-center px-1.5"
      >
        <span
          className={`flex h-4 w-4 items-center justify-center border transition ${done
            ? 'border-[var(--color-accent)] bg-[rgba(var(--color-accent-rgb),0.15)] text-[var(--color-accent)]'
            : 'border-[var(--color-border-strong)]'}`}
        >
          {done && <Check size={11} />}
        </span>
      </button>

      {editing ? (
        <form className="flex min-w-0 flex-1 items-center gap-1" onSubmit={(e) => { e.preventDefault(); submitEdit() }}>
          <input
            autoFocus
            value={text}
            maxLength={LIMITS.checklistText}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false) }}
            aria-label="Item text"
            className={`flex-1 ${FIELD}`}
          />
          <button type="submit" className={`${ICON} hover:text-[var(--color-accent)]`} aria-label="Save the item">
            <Check size={12} />
          </button>
        </form>
      ) : (
        <span
          onDoubleClick={startEdit}
          className={`min-w-0 flex-1 break-words text-sm ${done ? 'text-[var(--color-text-faint)] line-through' : 'text-[var(--color-text)]'}`}
        >
          {item.text}
        </span>
      )}

      {!editing && (
        <button
          type="button"
          disabled={op.isPending}
          onClick={startEdit}
          aria-label="Edit this item"
          title="Edit this item"
          className={`${ICON} hover:text-[var(--color-accent)]`}
        >
          <Pencil size={11} />
        </button>
      )}
      <button
        type="button"
        disabled={op.isPending}
        onClick={() => op.mutate({ op: 'remove', itemId: item.id })}
        aria-label="Remove this item"
        title="Remove this item. The activity tab can undo it."
        className={`${ICON} hover:text-[var(--color-danger)]`}
      >
        <X size={12} />
      </button>
    </li>
  )
}

// Keyed on the tab, so a half-typed item never follows the page to another tab.
export function ChecklistTab(p: CustomTabProps) {
  return <ChecklistTabBody key={p.tab.id} {...p} />
}

function ChecklistTabBody({ projectId, doc, tab }: CustomTabProps) {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const add = useItemOp(projectId, tab.id, setError, 'could not add that item')

  const items = tab.kind === 'checklist' ? (tab.items as ChecklistItem[]) : []
  // Stored order inside each group, open first, so a ticked item sinks without
  // reshuffling the ones still to do.
  const ordered = [...items.filter((i) => !i.done), ...items.filter((i) => i.done)]
  const open = items.length - items.filter((i) => i.done).length
  const full = items.length >= LIMITS.itemsPerTab

  const submit = () => {
    const text = draft.trim()
    if (!text || full) return
    setError('')
    add.mutate({ op: 'add', text }, { onSuccess: () => setDraft('') })
  }

  return (
    <div>
      <TabTools projectId={projectId} tab={tab} index={doc.tabs.findIndex((t) => t.id === tab.id)} count={doc.tabs.length} />
      {items.length > 0 && (
        <div className="mb-1 text-[11px] text-[var(--color-text-faint)]">
          {open} open · {items.length - open} done
        </div>
      )}
      {ordered.length === 0 ? (
        <div className="py-2 text-[11px] text-[var(--color-text-faint)]">No items yet. Add one below, or ask a session to.</div>
      ) : (
        <ul>
          {ordered.map((item) => (
            <ItemRow key={item.id} projectId={projectId} tabId={tab.id} item={item} onError={setError} />
          ))}
        </ul>
      )}
      <form className="mt-3 flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); submit() }}>
        <input
          value={draft}
          maxLength={LIMITS.checklistText}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={full ? `full at ${LIMITS.itemsPerTab} items` : 'add item'}
          disabled={full}
          aria-label="New item"
          className={`flex-1 ${FIELD}`}
        />
        <button
          type="submit"
          disabled={add.isPending || !draft.trim() || full}
          className={`shrink-0 ${BTN_ACCENT}`}
        >
          <Plus size={12} /> {add.isPending ? 'adding' : 'add'}
        </button>
      </form>
      {error && <div className="mt-2 text-xs text-[var(--color-danger)]">{error}</div>}
    </div>
  )
}
