import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Eye, EyeOff, Plus, Trash2, Link2, X, ChevronsLeft, ChevronsRight } from 'lucide-react'
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

// KCD2-style quest journal: category tabs up top, grouped quest list on the
// left, and a journal pane on the right for the selected quest. Selection is
// gold (accent-2), like the game's parchment highlight. The list pane is
// resizable (drag the divider) and collapsible (button, or drag it closed).

const CATEGORY_LABEL: Record<QuestCategory, string> = { main: 'MAIN', side: 'SIDE', daily: 'DAILY', work: 'WORK' }
// Work (Autotask tickets) and personal (main/side/daily) are separate worlds;
// the tabs split them and the group banners keep them sorted within a tab.
const GROUP_ORDER: QuestCategory[] = ['work', 'main', 'side', 'daily']
const GROUP_TITLE: Record<QuestCategory, string> = {
  main: 'main quests', work: 'work orders', side: 'side quests', daily: 'dailies',
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

// The ticket sync manages a "[Autotask] <status>" first line in the detail;
// split it out so it renders as a status chip instead of journal text.
function splitDetail(detail: string): { autotask: string | null; body: string } {
  const lines = (detail || '').split('\n')
  const m = lines[0]?.match(/^\[Autotask\] (.+)$/)
  if (m) return { autotask: m[1], body: lines.slice(1).join('\n').trim() }
  return { autotask: null, body: (detail || '').trim() }
}

type Tab = 'all' | 'work' | 'personal' | 'done'
const TABS: Tab[] = ['all', 'work', 'personal', 'done']

function buildGroups(all: Quest[], tab: Tab): { cat: QuestCategory; quests: Quest[] }[] {
  const isDone = (q: Quest) => q.status === 'completed' || q.status === 'failed'
  const visible = all.filter((q) => {
    if (tab === 'done') return isDone(q)
    if (isDone(q)) return false
    if (tab === 'work') return q.category === 'work'
    if (tab === 'personal') return q.category !== 'work'
    return true
  })
  return GROUP_ORDER
    .map((cat) => ({ cat, quests: visible.filter((q) => q.category === cat).sort(questSort) }))
    .filter((g) => g.quests.length > 0)
}

// Split-pane sizing (wide mode only; persisted across sessions).
const LIST_W_KEY = 'valkyrie-quests-listw'
const COLLAPSED_KEY = 'valkyrie-quests-collapsed'
const MIN_LIST_W = 280
const COLLAPSE_AT = 160
const DEFAULT_LIST_W = 480

// ── left pane ────────────────────────────────────────────────────────────────

function QuestListRow({ quest, selected, onSelect }: { quest: Quest; selected: boolean; onSelect: () => void }) {
  const s = STATUS_GLYPH[quest.status]
  const dimmed = quest.status === 'completed' || quest.status === 'failed'
  const { autotask } = splitDetail(quest.detail)
  const nextSub = quest.subquests.find((x) => x.status !== 'completed')
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`block w-full border-l-2 px-3 py-2.5 text-left transition ${
        selected
          ? 'border-[var(--color-accent-2)] bg-[rgba(255,229,0,0.07)]'
          : 'border-transparent hover:bg-[rgba(var(--color-accent-rgb),0.04)]'
      } ${dimmed ? 'opacity-55' : ''}`}
    >
      <div className="flex items-center gap-2.5">
        <span
          className={`flex h-6 w-6 shrink-0 items-center justify-center border text-[13px] ${s.tone} ${
            selected ? 'border-[var(--color-accent-2)]/60' : 'border-[var(--color-border)]'
          }`}
          title={s.label}
        >
          {s.glyph}
        </span>
        <span className={`min-w-0 flex-1 truncate text-[15px] ${
          selected ? 'font-semibold text-[var(--color-accent-2)]' : dimmed ? 'text-[var(--color-text-dim)]' : 'text-[var(--color-text)]'
        }`}>
          {quest.title}
        </span>
        {quest.tracked && !dimmed && (
          <Eye size={13} className="shrink-0 text-[var(--color-accent)]" aria-label="Tracked" />
        )}
      </div>
      {/* KCD2 shows the objective under the highlighted quest, and a red note
          on unavailable ones; here that note is the Autotask waiting status. */}
      {quest.status === 'on_hold' && autotask ? (
        <div className="mt-1 pl-[34px] text-[11px] uppercase tracking-[0.1em] text-[var(--color-warning)]">{autotask}</div>
      ) : (selected || quest.tracked) && nextSub && quest.status === 'active' ? (
        <div className="mt-1 truncate pl-[34px] text-xs italic text-[var(--color-text-dim)]">{nextSub.title}</div>
      ) : null}
      {quest.progress.total > 0 && !dimmed && (
        <div className="mt-1 max-w-[240px] pl-[34px]">
          <QuestProgressBar done={quest.progress.done} total={quest.progress.total} status={quest.status} />
        </div>
      )}
    </button>
  )
}

function NewQuestRow({ onCreated }: { onCreated: (q: QuestRow) => void }) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [category, setCategory] = useState<QuestCategory>('side')
  const create = useMutation({
    mutationFn: (input: { title: string; category: QuestCategory }) => createQuest(input),
    onSuccess: (q) => { setTitle(''); setOpen(false); onCreated(q) },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['quests'] }),
  })

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="block w-full border border-dashed border-[var(--color-border)] px-3 py-2.5 text-left text-[11px] uppercase tracking-[0.18em] text-[var(--color-text-faint)] transition hover:border-[var(--color-accent)]/50 hover:text-[var(--color-accent)]"
      >
        + accept new quest
      </button>
    )
  }
  return (
    <form
      className="space-y-2 border border-[var(--color-border-strong)] p-3"
      onSubmit={(e) => {
        e.preventDefault()
        const t = title.trim()
        if (t) create.mutate({ title: t, category })
      }}
    >
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="quest title…"
        className="w-full border border-[var(--color-border)] bg-transparent px-3 py-2 text-[15px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-border-strong)]"
      />
      <div className="flex items-center gap-2">
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as QuestCategory)}
          aria-label="Category"
          className="border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-[11px] uppercase tracking-[0.1em] text-[var(--color-text-dim)] outline-none"
        >
          <option value="main">main</option>
          <option value="side">side</option>
          <option value="daily">daily</option>
          <option value="work">work</option>
        </select>
        <button
          type="submit"
          disabled={!title.trim() || create.isPending}
          className="border border-[var(--color-accent)]/60 px-3 py-1.5 text-[11px] uppercase tracking-[0.14em] text-[var(--color-accent)] transition hover:bg-[rgba(var(--color-accent-rgb),0.08)] disabled:opacity-40"
        >
          accept
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="ml-auto text-[var(--color-text-faint)] transition hover:text-[var(--color-text-dim)]"
          aria-label="Cancel"
        >
          <X size={15} />
        </button>
      </div>
      {create.error != null && (
        <div className="text-xs text-[var(--color-danger)]">! {errMsg(create.error)}</div>
      )}
    </form>
  )
}

// ── right pane: the journal ──────────────────────────────────────────────────

function QuestJournal({ quest }: { quest: Quest }) {
  const queryClient = useQueryClient()
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
  const { autotask, body } = splitDetail(quest.detail)
  const mutationError = patch.error ?? addSub.error ?? remove.error ?? removeLink.error

  return (
    <div className="border border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-5">
      {/* title + meta, gold like the game's journal heading */}
      <div className="flex items-start justify-between gap-3">
        <h2
          className="min-w-0 text-xl font-bold leading-snug tracking-[0.04em] text-[var(--color-accent-2)]"
          style={{ textShadow: '0 0 14px rgba(255,229,0,0.35)' }}
        >
          {quest.title}
        </h2>
        <div className="flex shrink-0 items-center gap-2 pt-0.5">
          <button
            type="button"
            onClick={() => patch.mutate({ id: quest.id, patch: { tracked: !quest.tracked } })}
            title={quest.tracked ? 'Untrack quest' : 'Track quest'}
            aria-label={quest.tracked ? 'Untrack quest' : 'Track quest'}
            className={`border p-2 transition ${
              quest.tracked
                ? 'border-[var(--color-accent)]/70 text-[var(--color-accent)]'
                : 'border-[var(--color-border)] text-[var(--color-text-faint)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text-dim)]'
            }`}
          >
            {quest.tracked ? <Eye size={17} /> : <EyeOff size={17} />}
          </button>
          {confirmDelete ? (
            <span className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => remove.mutate(quest.id)}
                className="border border-[var(--color-danger)] px-2.5 py-1.5 text-[11px] uppercase tracking-[0.12em] text-[var(--color-danger)]"
              >
                confirm
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="border border-[var(--color-border)] px-2.5 py-1.5 text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-dim)]"
              >
                keep
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              aria-label="Delete quest"
              className="border border-[var(--color-border)] p-2 text-[var(--color-text-faint)] transition hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]"
            >
              <Trash2 size={16} />
            </button>
          )}
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
        <span className="border border-[var(--color-border-strong)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--color-text-dim)]">
          {CATEGORY_LABEL[quest.category]}
        </span>
        <span className={`text-xs uppercase tracking-[0.14em] ${s.tone}`}>{s.glyph} {s.label}</span>
        {autotask && (
          <span className="border border-[var(--color-warning)]/50 px-2 py-0.5 text-[11px] uppercase tracking-[0.12em] text-[var(--color-warning)]">
            autotask: {autotask}
          </span>
        )}
      </div>

      {mutationError != null && (
        <div className="mt-3 text-xs text-[var(--color-danger)]">! {errMsg(mutationError)}</div>
      )}

      {/* journal body */}
      {body && (
        <p className="mt-4 whitespace-pre-wrap text-sm leading-relaxed text-[var(--color-text-dim)] first-letter:pr-0.5 first-letter:text-2xl first-letter:font-bold first-letter:text-[var(--color-accent-2)]">
          {body}
        </p>
      )}

      {/* objectives, journal-entry style: done ones read as past entries */}
      <div className="mt-5">
        <div className="mb-2 flex items-center gap-3">
          <span className="text-[10px] uppercase tracking-[0.22em] text-[var(--color-text-faint)]">objectives</span>
          {quest.progress.total > 0 && (
            <div className="max-w-[240px] flex-1">
              <QuestProgressBar done={quest.progress.done} total={quest.progress.total} status={quest.status} />
            </div>
          )}
        </div>
        {quest.subquests.length === 0 && (
          <div className="text-xs text-[var(--color-text-faint)]">no objectives yet</div>
        )}
        <div className="space-y-2">
          {quest.subquests.map((sub) => {
            const done = sub.status === 'completed'
            return (
              <div key={sub.id} className="group flex items-start gap-2.5">
                <button
                  type="button"
                  onClick={() => patch.mutate({ id: sub.id, patch: { status: done ? 'active' : 'completed' } })}
                  aria-label={done ? 'Reopen objective' : 'Complete objective'}
                  className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center border text-xs transition ${
                    done
                      ? 'border-[var(--color-success)]/50 text-[var(--color-success)] opacity-70'
                      : 'border-[var(--color-accent)]/60 text-[var(--color-accent)] hover:bg-[rgba(var(--color-accent-rgb),0.1)]'
                  }`}
                >
                  {done ? '✓' : '◆'}
                </button>
                <span className={`min-w-0 flex-1 text-sm leading-snug ${
                  done ? 'text-[var(--color-text-faint)]' : 'text-[var(--color-text)]'
                }`}>
                  {sub.title}
                </span>
                <button
                  type="button"
                  onClick={() => remove.mutate(sub.id)}
                  aria-label="Delete objective"
                  className="shrink-0 pt-0.5 text-[var(--color-text-faint)] opacity-0 transition hover:text-[var(--color-danger)] group-hover:opacity-100"
                >
                  <X size={14} />
                </button>
              </div>
            )
          })}
        </div>
        <form
          className="mt-2.5 flex items-center gap-2"
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
            className="min-w-0 flex-1 border border-[var(--color-border)] bg-transparent px-2.5 py-1.5 text-sm text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-border-strong)]"
          />
          <button
            type="submit"
            disabled={!subTitle.trim() || addSub.isPending}
            aria-label="Add objective"
            className="border border-[var(--color-border)] p-2 text-[var(--color-text-dim)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-40"
          >
            <Plus size={14} />
          </button>
        </form>
      </div>

      {/* connected emails / tickets / urls */}
      {quest.links.length > 0 && (
        <div className="mt-5">
          <div className="mb-1.5 text-[10px] uppercase tracking-[0.22em] text-[var(--color-text-faint)]">connected</div>
          <div className="space-y-1.5">
            {quest.links.map((l) => (
              <div key={l.id} className="group flex items-center gap-2 text-xs text-[var(--color-text-dim)]">
                <Link2 size={13} className="shrink-0 text-[var(--color-text-faint)]" />
                <span className="shrink-0 uppercase tracking-[0.1em] text-[var(--color-text-faint)]">[{l.kind}]</span>
                <span className="min-w-0 truncate">{l.label || l.ref}</span>
                <button
                  type="button"
                  onClick={() => removeLink.mutate(l.id)}
                  aria-label="Remove link"
                  className="shrink-0 text-[var(--color-text-faint)] opacity-0 transition hover:text-[var(--color-danger)] group-hover:opacity-100"
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* status controls */}
      <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] pt-4">
        {quest.status !== 'completed' && (
          <button
            type="button"
            onClick={() => patch.mutate({ id: quest.id, patch: { status: 'completed' } })}
            className="border border-[var(--color-border)] px-3 py-1.5 text-xs uppercase tracking-[0.14em] text-[var(--color-text-dim)] transition hover:border-[var(--color-success)] hover:text-[var(--color-success)]"
          >
            ✓ complete
          </button>
        )}
        {quest.status === 'active' && (
          <button
            type="button"
            onClick={() => patch.mutate({ id: quest.id, patch: { status: 'on_hold' } })}
            className="border border-[var(--color-border)] px-3 py-1.5 text-xs uppercase tracking-[0.14em] text-[var(--color-text-dim)] transition hover:border-[var(--color-warning)] hover:text-[var(--color-warning)]"
          >
            ◼ hold
          </button>
        )}
        {quest.status !== 'active' && (
          <button
            type="button"
            onClick={() => patch.mutate({ id: quest.id, patch: { status: 'active' } })}
            className="border border-[var(--color-border)] px-3 py-1.5 text-xs uppercase tracking-[0.14em] text-[var(--color-text-dim)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            ◆ reactivate
          </button>
        )}
        {quest.status === 'active' && (
          <button
            type="button"
            onClick={() => patch.mutate({ id: quest.id, patch: { status: 'failed' } })}
            className="border border-[var(--color-border)] px-3 py-1.5 text-xs uppercase tracking-[0.14em] text-[var(--color-text-dim)] transition hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]"
          >
            ✗ abandon
          </button>
        )}
        <select
          value={quest.category}
          onChange={(e) => patch.mutate({ id: quest.id, patch: { category: e.target.value as QuestCategory } })}
          aria-label="Quest category"
          className="ml-auto border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-xs uppercase tracking-[0.1em] text-[var(--color-text-dim)] outline-none"
        >
          <option value="main">main</option>
          <option value="side">side</option>
          <option value="daily">daily</option>
          <option value="work">work</option>
        </select>
      </div>
    </div>
  )
}

// ── page ─────────────────────────────────────────────────────────────────────

export default function Quests() {
  const quests = useQuery({ queryKey: ['quests'], queryFn: fetchQuests, refetchInterval: 30_000 })
  const [tab, setTab] = useState<Tab>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const journalRef = useRef<HTMLDivElement>(null)

  // Resizable / collapsible list pane (wide mode only).
  const [listW, setListW] = useState(() => {
    const saved = parseInt(localStorage.getItem(LIST_W_KEY) ?? '', 10)
    return Number.isFinite(saved) ? Math.max(MIN_LIST_W, saved) : DEFAULT_LIST_W
  })
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === '1')
  useEffect(() => { localStorage.setItem(LIST_W_KEY, String(listW)) }, [listW])
  useEffect(() => { localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0') }, [collapsed])
  const splitRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  const onDividerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onDividerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current || !splitRef.current) return
    const rect = splitRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    if (x < COLLAPSE_AT) { setCollapsed(true); return }  // drag closed
    setCollapsed(false)
    setListW(Math.min(Math.max(x, MIN_LIST_W), Math.max(MIN_LIST_W, rect.width - 400)))
  }
  const onDividerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = false
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* already released */ }
  }

  const groups = useMemo(() => buildGroups(quests.data ?? [], tab), [quests.data, tab])
  const flat = useMemo(() => groups.flatMap((g) => g.quests), [groups])
  const selected = flat.find((q) => q.id === selectedId) ?? flat[0] ?? null

  // When the container is too narrow for two panes, the journal stacks under
  // the list; bring it into view. Measured from the actual layout (works at
  // any zoom level) rather than a viewport media query.
  const selectQuest = (id: string) => {
    setSelectedId(id)
    setTimeout(() => {
      const list = listRef.current
      const journal = journalRef.current
      if (!list || !journal) return
      const stacked = journal.getBoundingClientRect().top >= list.getBoundingClientRect().bottom - 4
      if (stacked) journal.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 60)
  }

  const counts = useMemo(() => {
    const all = quests.data ?? []
    return {
      active: all.filter((q) => q.status === 'active').length,
      waiting: all.filter((q) => q.status === 'on_hold').length,
      done: all.filter((q) => q.status === 'completed').length,
    }
  }, [quests.data])

  return (
    // @container: the pane split below reacts to the space this page actually
    // gets, not the viewport, so UI zoom / DPI scaling / small windows keep
    // the two-pane layout as long as it physically fits. Full width always:
    // the journal is the page, no reading-column cap.
    <div className="@container w-full space-y-5">
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-[0.35em] text-[var(--color-text-faint)]">// quest log</div>
          <h1 className="mt-1 whitespace-nowrap text-2xl font-bold tracking-[0.12em]" style={{ color: 'var(--color-accent)', textShadow: '0 0 16px var(--color-accent)' }}>
            quests<span className="cursor-blink">_</span>
          </h1>
        </div>
        <div className="text-[13px] uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
          [{counts.active} active · {counts.waiting} waiting · {counts.done} done]
        </div>
      </div>

      {/* category tabs, KCD2's shield strip */}
      <div className="flex items-center gap-1.5 border-b border-[var(--color-border)] pb-2">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`border px-3.5 py-1.5 text-xs uppercase tracking-[0.16em] transition ${
              tab === t
                ? 'border-[var(--color-accent)]/70 bg-[rgba(var(--color-accent-rgb),0.06)] text-[var(--color-accent)]'
                : 'border-[var(--color-border)] text-[var(--color-text-faint)] hover:text-[var(--color-text-dim)]'
            }`}
            style={tab === t ? { boxShadow: '0 0 8px rgba(var(--color-accent-rgb),0.2)' } : undefined}
          >
            {t}
          </button>
        ))}
      </div>

      {quests.isLoading ? (
        <div className="text-sm text-[var(--color-text-dim)]">loading…</div>
      ) : quests.error ? (
        <div className="text-sm text-[var(--color-danger)]">quest log unavailable</div>
      ) : (
        <div
          ref={splitRef}
          className="flex flex-col gap-4 @2xl:flex-row @2xl:items-start @2xl:gap-0"
          style={{ '--listw': `${listW}px` } as CSSProperties}
        >
          {/* collapsed rail (wide mode only; stacked view always shows the list) */}
          {collapsed && (
            <button
              type="button"
              onClick={() => setCollapsed(false)}
              title="Expand quest list"
              aria-label="Expand quest list"
              className="hidden self-stretch @2xl:mr-4 @2xl:flex @2xl:w-9 @2xl:shrink-0 @2xl:flex-col @2xl:items-center @2xl:gap-2 border border-[var(--color-border)] pt-2.5 text-[var(--color-text-dim)] transition hover:border-[var(--color-accent)]/60 hover:text-[var(--color-accent)]"
            >
              <ChevronsRight size={16} />
              <span className="text-[10px] uppercase tracking-[0.2em]" style={{ writingMode: 'vertical-rl' }}>
                quest list ({flat.length})
              </span>
            </button>
          )}

          {/* left: the quest list */}
          <div
            ref={listRef}
            className={`space-y-2 @2xl:w-[var(--listw)] @2xl:shrink-0 @2xl:max-h-[calc(100vh-230px)] @2xl:overflow-y-auto @2xl:pr-1 ${collapsed ? '@2xl:hidden' : ''}`}
          >
            <div className="flex gap-2">
              <div className="min-w-0 flex-1">
                <NewQuestRow onCreated={(q) => setSelectedId(q.id)} />
              </div>
              <button
                type="button"
                onClick={() => setCollapsed(true)}
                title="Collapse quest list"
                aria-label="Collapse quest list"
                className="hidden shrink-0 items-center border border-[var(--color-border)] px-2 text-[var(--color-text-faint)] transition hover:border-[var(--color-accent)]/60 hover:text-[var(--color-accent)] @2xl:flex"
              >
                <ChevronsLeft size={16} />
              </button>
            </div>
            {flat.length === 0 && (
              <div className="px-1 py-4 text-sm text-[var(--color-text-dim)]">
                &gt; no quests{tab !== 'all' ? ` (${tab})` : ''}. accept one above.
              </div>
            )}
            {groups.map((g) => (
              <div key={g.cat}>
                <div className="mb-1 border-y border-[var(--color-border)] bg-[rgba(var(--color-accent-rgb),0.04)] px-3 py-1.5 text-[10px] uppercase tracking-[0.28em] text-[var(--color-text-dim)]">
                  {GROUP_TITLE[g.cat]}
                </div>
                <div className="space-y-0.5">
                  {g.quests.map((q) => (
                    <QuestListRow key={q.id} quest={q} selected={selected?.id === q.id} onSelect={() => selectQuest(q.id)} />
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* drag divider (wide mode only): resize the list, drag closed to collapse */}
          {!collapsed && (
            <div
              role="separator"
              aria-orientation="vertical"
              title="Drag to resize · double-click to reset"
              onPointerDown={onDividerDown}
              onPointerMove={onDividerMove}
              onPointerUp={onDividerUp}
              onDoubleClick={() => setListW(DEFAULT_LIST_W)}
              className="group hidden shrink-0 cursor-col-resize touch-none self-stretch @2xl:flex @2xl:w-4 @2xl:justify-center"
            >
              <div className="w-px bg-[var(--color-border)] transition group-hover:w-0.5 group-hover:bg-[var(--color-accent)] group-hover:shadow-[0_0_8px_var(--color-accent)]" />
            </div>
          )}

          {/* right: the journal */}
          <div ref={journalRef} className="min-w-0 flex-1">
            {selected ? (
              <QuestJournal key={selected.id} quest={selected} />
            ) : (
              <div className="border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-10 text-center text-sm text-[var(--color-text-faint)]">
                &gt; select a quest to open its journal
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
