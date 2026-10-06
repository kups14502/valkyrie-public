import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, X } from 'lucide-react'
import { apiErrorText } from '../../lib/api'
import {
  LIMITS, PROJ_KEYS, projTabItem,
  type CustomTabProps, type LinkItem, type TabItemOp,
} from '../../lib/projectsApi'
import { safeHref } from '../Markdown'
import { BTN_ACCENT, FIELD } from './Sheet'
import { TabTools } from './TabTools'

// What the faint line under a label says: the host for a web link, the path
// for one inside the app.
const whereTo = (href: string): string => {
  if (href.startsWith('/')) return href
  try {
    const u = new URL(href)
    return u.protocol === 'mailto:' ? u.pathname : u.host
  } catch {
    return href
  }
}

// Keyed on the tab, so a half-typed link never follows the page to another tab.
export function LinksTab(p: CustomTabProps) {
  return <LinksTabBody key={p.tab.id} {...p} />
}

function LinksTabBody({ projectId, doc, tab }: CustomTabProps) {
  const qc = useQueryClient()
  const [label, setLabel] = useState('')
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')

  const op = useMutation({
    mutationFn: (body: TabItemOp) => projTabItem(projectId, tab.id, body),
    onSuccess: () => Promise.all([
      qc.invalidateQueries({ queryKey: PROJ_KEYS.doc(projectId) }),
      qc.invalidateQueries({ queryKey: PROJ_KEYS.events(projectId) }),
    ]),
    onError: (e: unknown) => setError(apiErrorText(e, 'could not change the links')),
  })

  const items = tab.kind === 'links' ? (tab.items as LinkItem[]) : []
  const full = items.length >= LIMITS.itemsPerTab
  const target = safeHref(url)
  const removingId = op.isPending && op.variables.op === 'remove' ? op.variables.itemId : null

  const submit = () => {
    if (!target || full) return
    setError('')
    op.mutate(
      { op: 'add', label: label.trim() || whereTo(target), url: url.trim() },
      { onSuccess: () => { setLabel(''); setUrl('') } },
    )
  }

  return (
    <div>
      <TabTools projectId={projectId} tab={tab} index={doc.tabs.findIndex((t) => t.id === tab.id)} count={doc.tabs.length} />
      {items.length === 0 ? (
        <div className="py-2 text-[11px] text-[var(--color-text-faint)]">No links yet. Add one below, or ask a session to.</div>
      ) : (
        <ul>
          {items.map((item) => {
            const href = safeHref(item.url)
            const text = (
              <>
                <span className="block truncate text-sm">{item.label}</span>
                <span className="block truncate text-[11px] text-[var(--color-text-faint)]">
                  {href ? whereTo(href) : '[blocked link]'}
                </span>
              </>
            )
            const cls = 'block min-w-0 flex-1 py-1.5 text-[var(--color-text)] transition hover:text-[var(--color-accent)]'
            return (
              <li
                key={item.id}
                className={`flex items-center gap-2 border-b border-[var(--color-border)] last:border-b-0${removingId === item.id ? ' opacity-40' : ''}`}
              >
                {!href ? (
                  <span className="block min-w-0 flex-1 py-1.5 text-[var(--color-text-dim)]" title={item.url}>{text}</span>
                ) : href.startsWith('/') ? (
                  <Link to={href} className={cls}>{text}</Link>
                ) : (
                  <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>{text}</a>
                )}
                <button
                  type="button"
                  disabled={op.isPending}
                  onClick={() => op.mutate({ op: 'remove', itemId: item.id })}
                  aria-label={`Remove ${item.label}`}
                  title="Remove this link. The activity tab can undo it."
                  className="inline-flex min-h-9 shrink-0 items-center border border-transparent px-2 text-[var(--color-text-faint)] transition hover:text-[var(--color-danger)] disabled:opacity-30"
                >
                  <X size={12} />
                </button>
              </li>
            )
          })}
        </ul>
      )}

      <form className="mt-3 space-y-2" onSubmit={(e) => { e.preventDefault(); submit() }}>
        <div className="flex flex-wrap gap-2">
          <input
            value={label}
            maxLength={LIMITS.linkLabel}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="label"
            disabled={full}
            aria-label="Link label"
            className={`sm:w-44 ${FIELD}`}
          />
          <input
            value={url}
            maxLength={LIMITS.url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={full ? `full at ${LIMITS.itemsPerTab} links` : 'https://... or /path'}
            disabled={full}
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-label="Link URL"
            className={`flex-1 basis-48 ${FIELD}`}
          />
          <button
            type="submit"
            disabled={op.isPending || !target || full}
            className={`shrink-0 ${BTN_ACCENT}`}
          >
            <Plus size={12} /> {op.isPending && op.variables.op === 'add' ? 'adding' : 'add'}
          </button>
        </div>
        {url.trim() && !target && (
          <div className="text-[11px] text-[var(--color-warning)]">Only http, https, mailto and /paths inside Valkyrie are allowed.</div>
        )}
      </form>
      {error && <div className="mt-2 text-xs text-[var(--color-danger)]">{error}</div>}
    </div>
  )
}
