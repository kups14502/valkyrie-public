import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Eye, EyeOff, Plus, Trash2, ChevronDown, ChevronRight, Link2, X } from 'lucide-react'
import { Card } from '../components/Card'
import { QuestProgressBar } from '../components/QuestProgressBar'
import {
  fetchQuests, createQuest, updateQuest, deleteQuest, deleteQuestLink,
  type Quest, type QuestRow, type QuestCategory, type QuestStatus,
} from '../lib/api'

// Backend detail (e.g. "invalid category") beats axios's generic message.
const errMsg = (e: unknown) => {
  const err = e as { detail?: string; message?: string } | null
  return err?.detail || err?.message || 'request failed'
}

// Game-style quest log: quests with subquests, a tracked flag (surfaces the
// quest on the dashboard HUD), and status at a glance.

const CATEGORY_LABEL: Record<QuestCategory, string> = { main: 'MAIN', side: 'SIDE', daily: 'DAILY' }
const CATEGORY_TONE: Record<QuestCategory, string> = {
  main: 'border-[var(--color-accent)]/70 text-[var(--color-accent)]',
  side: 'border-[var(--color-border)] text-[var(--color-text-dim)]',
  daily: 'border-[#48e3ce]/60 text-[#48e3ce]',
}

const STATUS_GLYPH: Record<QuestStatus, { glyph: string; tone: string; label: string }> = {
  active: { glyph: '◆', tone: 'text-[var(--color-accent)]', label: 'active' },
  completed: { glyph: '✓', tone: 'text-[var(--color-success)]', label: 'done' },
  failed: { glyph: '✗', tone: 'text-[var(--color-danger)]', label: 'failed' },
  on_hold: { glyph: '◼', tone: 'text-[var(--color-warning)]', label: 'on hold' },
}

// Sort: tracked first, then by status urgency, then newest first.
const STATUS_ORDER: Record<QuestStatus, number> = { active: 0, on_hold: 1, completed: 2, failed: 3 }
function questSort(a: Quest, b: Quest): number {
  if (a.tracked !== b.tracked) return a.tracked ? -1 : 1
  if (STATUS_ORDER[a.status] !== STATUS_ORDER[b.status]) return STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
  return b.createdAt.localeCompare(a.createdAt)
}

function Subquest({ sub, onToggle, onDelete }: { sub: QuestRow; onToggle: () => void; onDelete: () => void }) {
  const done = sub.status === 'completed'
  return (
    <div className="group flex items-center gap-2.5 py-1">
      <button
        type="button"
        onClick={onToggle}
        aria-label={done ? 'Reopen subquest' : 'Complete subquest'}
        className={`flex h-4 w-4 shrink-0 items-center justify-center border text-[10px] transition ${
          done
            ? 'border-[var(--color-success)] bg-[rgba(var(--color-accent-rgb),0.15)] text-[var(--color-success)]'
            : 'border-[var(--color-border-strong)] text-transparent hover:border-[var(--color-accent)]'
        }`}
      >
        ✓
      </button>
      <span className={`min-w-0 flex-1 text-sm ${done ? 'text-[var(--color-text-faint)] line-through' : 'text-[var(--color-text)]'}`}>
        {sub.title}
      </span>
      <button
        type="button"
        onClick={onDelete}
        aria-label="Delete subquest"
        className="shrink-0 text-[var(--color-text-faint)] opacity-0 transition hover:text-[var(--color-danger)] group-hover:opacity-100"
      >
        <X size={12} />
      </button>
    </div>
  )
}

function QuestCard({ quest }: { quest: Quest }) {
  const queryClient = useQueryClient()
  const [expanded, setExpanded] = useState(false)
  const [subTitle, setSubTitle] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['quests'] })
  const patch = useMutation({
    mutationFn: (input: { id: string; patch: Parameters<typeof updateQuest>[1] }) => updateQuest(input.id, input.patch),
    onSettled: invalidate,
  })
  const addSub = useMutation({
    mutationFn: (title: string) => createQuest({ title, parentId: quest.id }),
    onSuccess: () => setSubTitle(''),
    onSettled: invalidate,
  })
  const remove = useMutation({
    mutationFn: (id: string) => deleteQuest(id),
    onSettled: invalidate,
  })
  const removeLink = useMutation({
    mutationFn: (linkId: number) => deleteQuestLink(quest.id, linkId),
    onSettled: invalidate,
  })

  const s = STATUS_GLYPH[quest.status]
  const dimmed = quest.status === 'completed' || quest.status === 'failed'
  const nextSub = quest.subquests.find((x) => x.status !== 'completed')
  const mutationError = patch.error ?? addSub.error ?? remove.error ?? removeLink.error

  return (
    <div
      className={`border transition ${
        quest.tracked && !dimmed
          ? 'border-[var(--color-accent)]/60 bg-[rgba(var(--color-accent-rgb),0.04)]'
          : 'border-[var(--color-border)]'
      } ${dimmed ? 'opacity-60' : ''}`}
      style={quest.tracked && !dimmed ? { boxShadow: '0 0 10px rgba(var(--color-accent-rgb),0.12)' } : undefined}
    >
      {/* header row */}
      <div className="flex cursor-pointer items-center gap-2.5 px-3 py-2.5" onClick={() => setExpanded((v) => !v)}>
        <span className={`shrink-0 text-sm ${s.tone}`} title={s.label}>{s.glyph}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className={`text-sm font-semibold ${dimmed ? 'text-[var(--color-text-dim)]' : 'text-[var(--color-text)]'}`}>
              {quest.title}
            </span>
            <span className={`border px-1 py-px text-[8px] font-bold uppercase tracking-[0.16em] ${CATEGORY_TONE[quest.category]}`}>
              {CATEGORY_LABEL[quest.category]}
            </span>
            {quest.status === 'on_hold' && (
              <span className="text-[9px] uppercase tracking-[0.14em] text-[var(--color-warning)]">[on hold]</span>
            )}
          </div>
          {quest.progress.total > 0 && (
            <div className="mt-1.5 max-w-[280px]">
              <QuestProgressBar done={quest.progress.done} total={quest.progress.total} status={quest.status} />
            </div>
          )}
          {!expanded && nextSub && quest.status === 'active' && (
            <div className="mt-1 truncate text-[11px] text-[var(--color-text-faint)]">▸ {nextSub.title}</div>
          )}
        </div>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); patch.mutate({ id: quest.id, patch: { tracked: !quest.tracked } }) }}
          title={quest.tracked ? 'Untrack quest' : 'Track quest'}
          aria-label={quest.tracked ? 'Untrack quest' : 'Track quest'}
          className={`shrink-0 border p-1.5 transition ${
            quest.tracked
              ? 'border-[var(--color-accent)]/70 text-[var(--color-accent)]'
              : 'border-[var(--color-border)] text-[var(--color-text-faint)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text-dim)]'
          }`}
        >
          {quest.tracked ? <Eye size={13} /> : <EyeOff size={13} />}
        </button>
        <span className="shrink-0 text-[var(--color-text-faint)]">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </div>

      {expanded && (
        <div className="space-y-3 border-t border-[var(--color-border)] px-3 py-3">
          {mutationError != null && (
            <div className="text-[11px] text-[var(--color-danger)]">! {errMsg(mutationError)}</div>
          )}
          {quest.detail && (
            <div className="whitespace-pre-wrap text-xs leading-relaxed text-[var(--color-text-dim)]">{quest.detail}</div>
          )}

          {/* subquests */}
          <div>
            <div className="mb-1 text-[9px] uppercase tracking-[0.22em] text-[var(--color-text-faint)]">objectives</div>
            {quest.subquests.length === 0 && (
              <div className="text-[11px] text-[var(--color-text-faint)]">no objectives yet</div>
            )}
            {quest.subquests.map((sub) => (
              <Subquest
                key={sub.id}
                sub={sub}
                onToggle={() => patch.mutate({ id: sub.id, patch: { status: sub.status === 'completed' ? 'active' : 'completed' } })}
                onDelete={() => remove.mutate(sub.id)}
              />
            ))}
            <form
              className="mt-1.5 flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                const t = subTitle.trim()
                if (t) addSub.mutate(t)
              }}
            >
              <input
                value={subTitle}
                onChange={(e) => setSubTitle(e.target.value)}
                placeholder="+ add objective"
                className="min-w-0 flex-1 border border-[var(--color-border)] bg-transparent px-2 py-1 text-xs text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-border-strong)]"
              />
              <button
                type="submit"
                disabled={!subTitle.trim() || addSub.isPending}
                aria-label="Add objective"
                className="border border-[var(--color-border)] p-1.5 text-[var(--color-text-dim)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-40"
              >
                <Plus size={12} />
              </button>
            </form>
          </div>

          {/* connected emails / tickets / urls */}
          {quest.links.length > 0 && (
            <div>
              <div className="mb-1 text-[9px] uppercase tracking-[0.22em] text-[var(--color-text-faint)]">connected</div>
              <div className="space-y-1">
                {quest.links.map((l) => (
                  <div key={l.id} className="group flex items-center gap-2 text-[11px] text-[var(--color-text-dim)]">
                    <Link2 size={11} className="shrink-0 text-[var(--color-text-faint)]" />
                    <span className="shrink-0 uppercase tracking-[0.1em] text-[var(--color-text-faint)]">[{l.kind}]</span>
                    <span className="min-w-0 truncate">{l.label || l.ref}</span>
                    <button
                      type="button"
                      onClick={() => removeLink.mutate(l.id)}
                      aria-label="Remove link"
                      className="shrink-0 text-[var(--color-text-faint)] opacity-0 transition hover:text-[var(--color-danger)] group-hover:opacity-100"
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* status controls */}
          <div className="flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] pt-3">
            {quest.status !== 'completed' && (
              <button
                type="button"
                onClick={() => patch.mutate({ id: quest.id, patch: { status: 'completed' } })}
                className="border border-[var(--color-border)] px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-dim)] transition hover:border-[var(--color-success)] hover:text-[var(--color-success)]"
              >
                ✓ complete
              </button>
            )}
            {quest.status === 'active' && (
              <button
                type="button"
                onClick={() => patch.mutate({ id: quest.id, patch: { status: 'on_hold' } })}
                className="border border-[var(--color-border)] px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-dim)] transition hover:border-[var(--color-warning)] hover:text-[var(--color-warning)]"
              >
                ◼ hold
              </button>
            )}
            {quest.status !== 'active' && (
              <button
                type="button"
                onClick={() => patch.mutate({ id: quest.id, patch: { status: 'active' } })}
                className="border border-[var(--color-border)] px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-dim)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
              >
                ◆ reactivate
              </button>
            )}
            {quest.status === 'active' && (
              <button
                type="button"
                onClick={() => patch.mutate({ id: quest.id, patch: { status: 'failed' } })}
                className="border border-[var(--color-border)] px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-dim)] transition hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]"
              >
                ✗ abandon
              </button>
            )}
            <div className="ml-auto flex items-center gap-2">
              <select
                value={quest.category}
                onChange={(e) => patch.mutate({ id: quest.id, patch: { category: e.target.value as QuestCategory } })}
                aria-label="Quest category"
                className="border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-1 text-[10px] uppercase tracking-[0.1em] text-[var(--color-text-dim)] outline-none"
              >
                <option value="main">main</option>
                <option value="side">side</option>
                <option value="daily">daily</option>
              </select>
              {confirmDelete ? (
                <span className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => remove.mutate(quest.id)}
                    className="border border-[var(--color-danger)] px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-[var(--color-danger)]"
                  >
                    confirm
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                    className="border border-[var(--color-border)] px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-dim)]"
                  >
                    keep
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  aria-label="Delete quest"
                  className="border border-[var(--color-border)] p-1.5 text-[var(--color-text-faint)] transition hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]"
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

type Filter = 'all' | 'tracked' | 'active' | 'done'

export default function Quests() {
  const queryClient = useQueryClient()
  const quests = useQuery({ queryKey: ['quests'], queryFn: fetchQuests, refetchInterval: 30_000 })
  const [filter, setFilter] = useState<Filter>('all')
  const [title, setTitle] = useState('')
  const [category, setCategory] = useState<QuestCategory>('side')

  const create = useMutation({
    mutationFn: (input: { title: string; category: QuestCategory }) => createQuest(input),
    onSuccess: () => setTitle(''),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['quests'] }),
  })

  const list = useMemo(() => {
    const all = [...(quests.data ?? [])].sort(questSort)
    switch (filter) {
      case 'tracked': return all.filter((q) => q.tracked)
      case 'active': return all.filter((q) => q.status === 'active' || q.status === 'on_hold')
      case 'done': return all.filter((q) => q.status === 'completed' || q.status === 'failed')
      default: return all
    }
  }, [quests.data, filter])

  const counts = useMemo(() => {
    const all = quests.data ?? []
    return {
      active: all.filter((q) => q.status === 'active').length,
      tracked: all.filter((q) => q.tracked).length,
      done: all.filter((q) => q.status === 'completed').length,
    }
  }, [quests.data])

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-[9px] uppercase tracking-[0.35em] text-[var(--color-text-faint)]">// quest log</div>
          <h1 className="mt-1 text-2xl font-bold tracking-[0.12em]" style={{ color: 'var(--color-accent)', textShadow: '0 0 16px var(--color-accent)' }}>
            quests<span className="cursor-blink">_</span>
          </h1>
        </div>
        <div className="text-xs uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
          [{counts.active} active · {counts.tracked} tracked · {counts.done} done]
        </div>
      </div>

      <Card title="New Quest">
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            const t = title.trim()
            if (t) create.mutate({ title: t, category })
          }}
        >
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="quest title…"
            className="min-w-[200px] flex-1 border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-border-strong)]"
          />
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as QuestCategory)}
            aria-label="Category"
            className="border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-2 text-xs uppercase tracking-[0.1em] text-[var(--color-text-dim)] outline-none"
          >
            <option value="main">main</option>
            <option value="side">side</option>
            <option value="daily">daily</option>
          </select>
          <button
            type="submit"
            disabled={!title.trim() || create.isPending}
            className="flex items-center gap-1.5 border border-[var(--color-accent)]/60 px-3 py-2 text-xs uppercase tracking-[0.14em] text-[var(--color-accent)] transition hover:bg-[rgba(var(--color-accent-rgb),0.08)] disabled:opacity-40"
          >
            <Plus size={13} /> accept
          </button>
          {create.error != null && (
            <span className="w-full text-[11px] text-[var(--color-danger)]">! {errMsg(create.error)}</span>
          )}
        </form>
      </Card>

      <Card
        title={`Quest Log (${list.length})`}
        action={
          <div className="flex items-center gap-1.5">
            {(['all', 'tracked', 'active', 'done'] as Filter[]).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`border px-2 py-0.5 text-[9px] uppercase tracking-[0.14em] transition ${
                  filter === f
                    ? 'border-[var(--color-accent)]/70 text-[var(--color-accent)]'
                    : 'border-[var(--color-border)] text-[var(--color-text-faint)] hover:text-[var(--color-text-dim)]'
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        }
      >
        {quests.isLoading ? (
          <div className="text-sm text-[var(--color-text-dim)]">loading…</div>
        ) : quests.error ? (
          <div className="text-sm text-[var(--color-danger)]">quest log unavailable</div>
        ) : list.length === 0 ? (
          <div className="text-sm text-[var(--color-text-dim)]">&gt; no quests{filter !== 'all' ? ` (${filter})` : ''}. accept one above.</div>
        ) : (
          <div className="space-y-2">
            {list.map((q) => <QuestCard key={q.id} quest={q} />)}
          </div>
        )}
      </Card>
    </div>
  )
}
