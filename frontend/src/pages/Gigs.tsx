import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Eye, EyeOff, Plus, Trash2, Link2, X, ChevronsLeft, ChevronsRight, ChevronDown, ChevronRight } from 'lucide-react'
import { GigProgressBar } from '../components/GigProgressBar'
import { GigChat } from '../components/GigChat'
import { gigColor } from '../lib/gigColor'
import {
  fetchGigs, fetchGigStats, createGig, updateGig, deleteGig, deleteGigLink,
  type Gig, type GigRow, type GigCategory, type GigStatus,
} from '../lib/api'

// Backend detail (e.g. "invalid category") beats axios's generic message.
const errMsg = (e: unknown) => {
  const err = e as { detail?: string; message?: string } | null
  return err?.detail || err?.message || 'request failed'
}

// KCD2-style gig journal: category tabs up top, grouped gig list on the
// left, and a journal pane on the right for the selected gig. Every gig
// has its own stable identity color (hashed from its id) used for its marker,
// selection highlight, and journal heading. The list pane is resizable (drag
// the divider) and collapsible (button, or drag it closed).

const CATEGORY_LABEL: Record<GigCategory, string> = { main: 'MAIN', side: 'SIDE', daily: 'DAILY', work: 'WORK' }
// Work (Autotask tickets) and personal (main/side/daily) are separate worlds;
// the tabs split them and the group banners keep them sorted within a tab.
const GROUP_ORDER: GigCategory[] = ['work', 'main', 'side', 'daily']
const GROUP_TITLE: Record<GigCategory, string> = {
  main: 'main gigs', work: 'work orders', side: 'side gigs', daily: 'dailies',
}

const STATUS_GLYPH: Record<GigStatus, { glyph: string; tone: string; label: string }> = {
  active: { glyph: '◆', tone: 'text-[var(--color-accent)]', label: 'active' },
  completed: { glyph: '✓', tone: 'text-[var(--color-success)]', label: 'done' },
  failed: { glyph: '✗', tone: 'text-[var(--color-danger)]', label: 'failed' },
  // Paused, not alarming: steel blue (yellow stays for real warnings).
  // Literal class (not template) so Tailwind's JIT sees it; keep in sync
  // with HOLD_COLOR in lib/gigColor.ts.
  on_hold: { glyph: '◼', tone: 'text-[#7c9cc4]', label: 'on hold' },
}

// Sort: tracked first, then by status urgency, then newest first.
const STATUS_ORDER: Record<GigStatus, number> = { active: 0, on_hold: 1, completed: 2, failed: 3 }
function gigSort(a: Gig, b: Gig): number {
  if (a.tracked !== b.tracked) return a.tracked ? -1 : 1
  if (STATUS_ORDER[a.status] !== STATUS_ORDER[b.status]) return STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
  return b.createdAt.localeCompare(a.createdAt)
}

// The ticket sync manages a "[Autotask] <status> · due <date> · client:<name>"
// first line in the detail; split it into the status chip, the due date, the
// client (used to group work gigs), and the journal body.
function splitDetail(detail: string): { autotask: string | null; due: string | null; client: string | null; body: string } {
  const lines = (detail || '').split('\n')
  const m = lines[0]?.match(/^\[Autotask\] (.+)$/)
  const body = lines.slice(1).join('\n').trim()
  if (!m) return { autotask: null, due: null, client: null, body: (detail || '').trim() }
  let auto = m[1]
  let client: string | null = null
  const cm = auto.match(/ · client:(.+)$/)
  if (cm) { client = cm[1].trim(); auto = auto.slice(0, cm.index).trim() }
  const dm = auto.match(/ · due (\d{4}-\d{2}-\d{2})/)
  const due = dm ? dm[1] : null
  return { autotask: auto, due, client, body }
}

// Due-date urgency, but only for gigs you can actually act on now: a gig
// waiting on someone else (on hold) or already done isn't "overdue" on you.
type DueUrgency = 'overdue' | 'today' | 'soon' | null
function dueUrgency(due: string | null, status: GigStatus): DueUrgency {
  if (!due || status !== 'active') return null
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const d = new Date(due + 'T00:00:00'); d.setHours(0, 0, 0, 0)
  const days = Math.round((d.getTime() - today.getTime()) / 86_400_000)
  if (days < 0) return 'overdue'
  if (days === 0) return 'today'
  if (days <= 3) return 'soon'
  return null
}
const DUE_STYLE: Record<Exclude<DueUrgency, null>, { label: string; cls: string }> = {
  overdue: { label: 'overdue', cls: 'border-[var(--color-danger)] text-[var(--color-danger)]' },
  today: { label: 'due today', cls: 'border-[var(--color-warning)] text-[var(--color-warning)]' },
  soon: { label: 'due soon', cls: 'border-[var(--color-warning)]/50 text-[var(--color-warning)]/80' },
}
function DueChip({ due, status }: { due: string | null; status: GigStatus }) {
  const u = dueUrgency(due, status)
  if (!u) return null
  return (
    <span className={`shrink-0 border px-1.5 py-px text-[9px] font-bold uppercase tracking-[0.1em] ${DUE_STYLE[u].cls}`}>
      {DUE_STYLE[u].label}
    </span>
  )
}

const gigClient = (q: Gig): string | null => splitDetail(q.detail).client
const UNASSIGNED = 'Unassigned'

// The ticket sync writes notes as '[Jul 16, 21:23] Author\ntext' blocks
// separated by blank lines; older syncs wrote single '[07-16 21:23] Author:
// text' lines. Parse both into dated entries; anything else (hand-written
// detail) stays a plain prose block.
type JournalEntry = { when?: string; who?: string; text: string }

function parseJournal(body: string): JournalEntry[] {
  const out: JournalEntry[] = []
  for (const block of body.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '')
    if (lines.length === 0) continue
    const header = lines[0].match(/^\[([^\]]+)\]\s+([^:]+)$/)
    if (header && lines.length > 1) {
      out.push({ when: header[1], who: header[2], text: lines.slice(1).join(' ') })
      continue
    }
    if (lines.some((l) => /^\[[^\]]+\]\s+[^:]+:\s+/.test(l))) {
      for (const line of lines) {
        const m = line.match(/^\[([^\]]+)\]\s+([^:]+):\s+(.+)$/)
        if (m) out.push({ when: m[1], who: m[2], text: m[3] })
        else if (out.length > 0 && out[out.length - 1].when) out[out.length - 1].text += ' ' + line
        else out.push({ text: line })
      }
    } else {
      out.push({ text: block })
    }
  }
  return out
}

type Tab = 'all' | 'work' | 'personal' | 'done'
const TABS: Tab[] = ['all', 'work', 'personal', 'done']

type Group = { key: string; title: string; gigs: Gig[] }

// A gig is "waiting on others" when it's on hold (the ticket sync parks
// waiting-customer/vendor/materials tickets there); nothing for you to do.
const isWaiting = (q: Gig) => q.status === 'on_hold'

// Named groups lead the list: work gigs under their Autotask client, other
// gigs under their custom section (if set). Sectionless personal gigs fall
// back to category groups. When hideWaiting is set, on-hold gigs are dropped
// entirely.
function buildGroups(all: Gig[], tab: Tab, hideWaiting: boolean): Group[] {
  const isDone = (q: Gig) => q.status === 'completed' || q.status === 'failed'
  const visible = all.filter((q) => {
    if (tab === 'done') return isDone(q)
    if (isDone(q)) return false
    if (hideWaiting && isWaiting(q)) return false
    if (tab === 'work') return q.category === 'work'
    if (tab === 'personal') return q.category !== 'work'
    return true
  })

  const byName = new Map<string, Gig[]>()
  for (const q of visible) {
    const name = q.category === 'work' ? (gigClient(q) || UNASSIGNED) : (q.section || null)
    if (!name) continue
    ;(byName.get(name) ?? byName.set(name, []).get(name)!).push(q)
  }
  const namedGroups: Group[] = [...byName.entries()]
    .sort((a, b) =>
      a[0] === UNASSIGNED ? 1 : b[0] === UNASSIGNED ? -1 : a[0].localeCompare(b[0]))
    .map(([name, qs]) => ({ key: `named:${name}`, title: name, gigs: qs.sort(gigSort) }))

  const categoryGroups: Group[] = GROUP_ORDER
    .filter((cat) => cat !== 'work')
    .map((cat) => ({
      key: cat,
      title: GROUP_TITLE[cat],
      gigs: visible.filter((q) => q.category === cat && !q.section).sort(gigSort),
    }))

  // `visible` is already tab-filtered, so named groups only ever contain
  // gigs belonging to the current tab.
  const out = tab === 'work' ? namedGroups : [...namedGroups, ...categoryGroups]
  return out.filter((g) => g.gigs.length > 0)
}

// Split-pane sizing (wide mode only; persisted across sessions).
const LIST_W_KEY = 'valkyrie-gigs-listw'
const COLLAPSED_KEY = 'valkyrie-gigs-collapsed'
const GROUPS_KEY = 'valkyrie-gigs-collapsed-groups'
const HIDE_WAITING_KEY = 'valkyrie-gigs-hide-waiting'
const MIN_LIST_W = 280
const COLLAPSE_AT = 160
const DEFAULT_LIST_W = 480

// ── left pane ────────────────────────────────────────────────────────────────

function GigListRow({ gig, selected, onSelect }: { gig: Gig; selected: boolean; onSelect: () => void }) {
  const s = STATUS_GLYPH[gig.status]
  const dimmed = gig.status === 'completed' || gig.status === 'failed'
  const { autotask, due } = splitDetail(gig.detail)
  const nextSub = gig.subgigs.find((x) => x.status !== 'completed')
  // Identity color marks TRACKED (workable) gigs only; waiting/untracked
  // rows go quiet grey so the list reads as "colored = act on this".
  const tracked = gig.tracked && !dimmed
  const color = tracked ? gigColor(gig.id) : undefined
  const neutral = gig.status === 'on_hold' ? 'rgba(124,156,196,0.75)' : 'var(--color-text-faint)'
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`block w-full border-l-2 px-3 py-2.5 text-left transition ${
        selected ? '' : 'border-transparent hover:bg-[rgba(var(--color-accent-rgb),0.04)]'
      } ${dimmed ? 'opacity-55' : ''}`}
      style={selected ? {
        borderLeftColor: color ?? neutral,
        backgroundColor: color ? gigColor(gig.id, 0.08) : 'rgba(255,255,255,0.04)',
      } : undefined}
    >
      <div className="flex items-center gap-2.5">
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center border text-[13px]"
          style={color
            ? { color, borderColor: gigColor(gig.id, selected ? 0.6 : 0.3) }
            : { color: neutral, borderColor: 'var(--color-border)' }}
          title={s.label}
        >
          {s.glyph}
        </span>
        <span
          className={`min-w-0 flex-1 truncate text-[15px] ${
            selected ? 'font-semibold' : dimmed ? 'text-[var(--color-text-dim)]' : tracked ? 'text-[var(--color-text)]' : 'text-[var(--color-text-dim)]'
          }`}
          style={selected ? { color: color ?? 'var(--color-text)' } : undefined}
        >
          {gig.title}
        </span>
        <DueChip due={due} status={gig.status} />
        {gig.tracked && !dimmed && (
          <Eye size={13} className="shrink-0 text-[var(--color-accent)]" aria-label="Tracked" />
        )}
      </div>
      {/* KCD2 shows the objective under the highlighted gig, and a red note
          on unavailable ones; here that note is the Autotask waiting status
          (steel = paused, not a warning). */}
      {gig.status === 'on_hold' && autotask ? (
        <div className="mt-1 pl-[34px] text-[11px] uppercase tracking-[0.1em] text-[#7c9cc4]">{autotask}</div>
      ) : (selected || gig.tracked) && nextSub && gig.status === 'active' ? (
        <div className="mt-1 truncate pl-[34px] text-xs italic text-[var(--color-text-dim)]">{nextSub.title}</div>
      ) : null}
      {gig.progress.total > 0 && !dimmed && (
        <div className="mt-1 max-w-[240px] pl-[34px]">
          <GigProgressBar done={gig.progress.done} total={gig.progress.total} status={gig.status} />
        </div>
      )}
    </button>
  )
}

function NewGigRow({ onCreated }: { onCreated: (q: GigRow) => void }) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [category, setCategory] = useState<GigCategory>('side')
  const create = useMutation({
    mutationFn: (input: { title: string; category: GigCategory }) => createGig(input),
    onSuccess: (q) => { setTitle(''); setOpen(false); onCreated(q) },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['gigs'] }),
  })

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="block w-full border border-dashed border-[var(--color-border)] px-3 py-2.5 text-left text-[11px] uppercase tracking-[0.18em] text-[var(--color-text-faint)] transition hover:border-[var(--color-accent)]/50 hover:text-[var(--color-accent)]"
      >
        + accept new gig
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
        placeholder="gig title…"
        className="w-full border border-[var(--color-border)] bg-transparent px-3 py-2 text-[15px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-border-strong)]"
      />
      <div className="flex items-center gap-2">
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as GigCategory)}
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

function GigJournal({ gig }: { gig: Gig }) {
  const queryClient = useQueryClient()
  const [subTitle, setSubTitle] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['gigs'] })
  const patch = useMutation({
    mutationFn: (input: { id: string; patch: Parameters<typeof updateGig>[1] }) => updateGig(input.id, input.patch),
    onSettled: invalidate,
  })
  const addSub = useMutation({
    mutationFn: (title: string) => createGig({ title, parentId: gig.id }),
    onSuccess: () => setSubTitle(''),
    onSettled: invalidate,
  })
  const remove = useMutation({
    mutationFn: (id: string) => deleteGig(id),
    onSettled: invalidate,
  })
  const removeLink = useMutation({
    mutationFn: (linkId: number) => deleteGigLink(gig.id, linkId),
    onSettled: invalidate,
  })

  const s = STATUS_GLYPH[gig.status]
  const { autotask, due, client, body } = splitDetail(gig.detail)
  const mutationError = patch.error ?? addSub.error ?? remove.error ?? removeLink.error
  // Identity color only while tracked (workable); untracked reads neutral.
  const tracked = gig.tracked && gig.status !== 'completed' && gig.status !== 'failed'
  const color = tracked ? gigColor(gig.id) : 'var(--color-text)'

  return (
    <div className="border border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-5">
      {/* title + meta in the gig's own identity color */}
      <div className="flex items-start justify-between gap-3">
        <h2
          className="min-w-0 text-xl font-bold leading-snug tracking-[0.04em]"
          style={{ color, textShadow: tracked ? `0 0 14px ${gigColor(gig.id, 0.4)}` : undefined }}
        >
          {gig.title}
        </h2>
        <div className="flex shrink-0 items-center gap-2 pt-0.5">
          <button
            type="button"
            onClick={() => patch.mutate({ id: gig.id, patch: { tracked: !gig.tracked } })}
            title={gig.tracked ? 'Untrack: remove this gig from the dashboard HUD.' : 'Track: pin this gig to the dashboard HUD.'}
            aria-label={gig.tracked ? 'Untrack gig' : 'Track gig'}
            className={`border p-2 transition ${
              gig.tracked
                ? 'border-[var(--color-accent)]/70 text-[var(--color-accent)]'
                : 'border-[var(--color-border)] text-[var(--color-text-faint)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text-dim)]'
            }`}
          >
            {gig.tracked ? <Eye size={17} /> : <EyeOff size={17} />}
          </button>
          {confirmDelete ? (
            <span className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => remove.mutate(gig.id)}
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
              aria-label="Delete gig"
              title="Delete this gig permanently (removes it entirely; use abandon to just shelve it)."
              className="border border-[var(--color-border)] p-2 text-[var(--color-text-faint)] transition hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]"
            >
              <Trash2 size={16} />
            </button>
          )}
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
        <span className="border border-[var(--color-border-strong)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--color-text-dim)]">
          {CATEGORY_LABEL[gig.category]}
        </span>
        {client && (
          <span className="border border-[var(--color-border-strong)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em]" style={{ color }}>
            {client}
          </span>
        )}
        {!client && gig.section && (
          <span className="border border-[var(--color-border-strong)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em]" style={{ color }}>
            {gig.section}
          </span>
        )}
        <span className={`text-xs uppercase tracking-[0.14em] ${s.tone}`}>{s.glyph} {s.label}</span>
        <DueChip due={due} status={gig.status} />
        {autotask && (
          <span className="border border-[#7c9cc4]/50 px-2 py-0.5 text-[11px] uppercase tracking-[0.12em] text-[#7c9cc4]">
            autotask: {autotask}
          </span>
        )}
      </div>

      {mutationError != null && (
        <div className="mt-3 text-xs text-[var(--color-danger)]">! {errMsg(mutationError)}</div>
      )}

      {/* journal body: ticket notes render as dated entries, plain detail as prose */}
      {body && (
        <div className="mt-4 space-y-3.5">
          {parseJournal(body).map((e, i) =>
            e.when ? (
              <div key={i}>
                <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-text-faint)]">
                  <span style={{ color }}>{e.when}</span> · {e.who}
                </div>
                <p className="mt-1 text-sm leading-relaxed text-[var(--color-text-dim)]">{e.text}</p>
              </div>
            ) : (
              <p
                key={i}
                className={`whitespace-pre-wrap text-sm leading-relaxed ${
                  i === 0
                    ? 'text-[var(--color-text)] first-letter:pr-0.5 first-letter:text-2xl first-letter:font-bold first-letter:text-[var(--qc)]'
                    : 'text-[var(--color-text-dim)]'
                }`}
                style={{ '--qc': color } as CSSProperties}
              >
                {e.text}
              </p>
            )
          )}
        </div>
      )}

      {/* objectives, journal-entry style: done ones read as past entries */}
      <div className="mt-5">
        <div className="mb-2 flex items-center gap-3">
          <span className="text-[10px] uppercase tracking-[0.22em] text-[var(--color-text-faint)]">objectives</span>
          {gig.progress.total > 0 && (
            <div className="max-w-[240px] flex-1">
              <GigProgressBar done={gig.progress.done} total={gig.progress.total} status={gig.status} />
            </div>
          )}
        </div>
        {gig.subgigs.length === 0 && (
          <div className="text-xs text-[var(--color-text-faint)]">no objectives yet</div>
        )}
        <div className="space-y-2">
          {gig.subgigs.map((sub) => {
            const done = sub.status === 'completed'
            return (
              <div key={sub.id} className="group flex items-start gap-2.5">
                <button
                  type="button"
                  onClick={() => patch.mutate({ id: sub.id, patch: { status: done ? 'active' : 'completed' } })}
                  aria-label={done ? 'Reopen objective' : 'Complete objective'}
                  title={done ? 'Reopen this objective.' : 'Mark this objective complete.'}
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
                  title="Delete this objective."
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
            title="Add this objective (a checklist step) to the gig."
            className="border border-[var(--color-border)] p-2 text-[var(--color-text-dim)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-40"
          >
            <Plus size={14} />
          </button>
        </form>
      </div>

      {/* connected emails / tickets / urls */}
      {gig.links.length > 0 && (
        <div className="mt-5">
          <div className="mb-1.5 text-[10px] uppercase tracking-[0.22em] text-[var(--color-text-faint)]">connected</div>
          <div className="space-y-1.5">
            {gig.links.map((l) => (
              <div key={l.id} className="group flex items-center gap-2 text-xs text-[var(--color-text-dim)]">
                <Link2 size={13} className="shrink-0 text-[var(--color-text-faint)]" />
                <span className="shrink-0 uppercase tracking-[0.1em] text-[var(--color-text-faint)]">[{l.kind}]</span>
                {/* Tickets show their number (the useful identifier); the
                    title already is the gig heading. Others show the label. */}
                <span className="min-w-0 truncate">{l.kind === 'ticket' ? l.ref : (l.label || l.ref)}</span>
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
        {gig.status !== 'completed' && (
          <button
            type="button"
            title="Mark this gig done and move it to the Done tab."
            onClick={() => patch.mutate({ id: gig.id, patch: { status: 'completed' } })}
            className="border border-[var(--color-border)] px-3 py-1.5 text-xs uppercase tracking-[0.14em] text-[var(--color-text-dim)] transition hover:border-[var(--color-success)] hover:text-[var(--color-success)]"
          >
            ✓ complete
          </button>
        )}
        {gig.status === 'active' && (
          <button
            type="button"
            title="Pause this gig as on-hold (a work gig returns to active if its Autotask ticket is still actionable)."
            onClick={() => patch.mutate({ id: gig.id, patch: { status: 'on_hold' } })}
            className="border border-[var(--color-border)] px-3 py-1.5 text-xs uppercase tracking-[0.14em] text-[var(--color-text-dim)] transition hover:border-[#7c9cc4] hover:text-[#7c9cc4]"
          >
            ◼ hold
          </button>
        )}
        {gig.status !== 'active' && (
          <button
            type="button"
            title="Reopen this gig as active."
            onClick={() => patch.mutate({ id: gig.id, patch: { status: 'active' } })}
            className="border border-[var(--color-border)] px-3 py-1.5 text-xs uppercase tracking-[0.14em] text-[var(--color-text-dim)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            ◆ reactivate
          </button>
        )}
        {gig.status === 'active' && (
          <button
            type="button"
            title="Abandon this gig: marks it failed and moves it to the Done tab. It stays there (the sync won't reopen it and the Autotask ticket is untouched)."
            onClick={() => patch.mutate({ id: gig.id, patch: { status: 'failed' } })}
            className="border border-[var(--color-border)] px-3 py-1.5 text-xs uppercase tracking-[0.14em] text-[var(--color-text-dim)] transition hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]"
          >
            ✗ abandon
          </button>
        )}
        <select
          value={gig.category}
          onChange={(e) => patch.mutate({ id: gig.id, patch: { category: e.target.value as GigCategory } })}
          aria-label="Gig category"
          title="Change this gig's category (moves it between the work and personal tabs)."
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

// ── XP / level ───────────────────────────────────────────────────────────────

function XpBar() {
  const stats = useQuery({ queryKey: ['gig-stats'], queryFn: fetchGigStats, refetchInterval: 60_000 })
  const s = stats.data
  if (!s) return null
  const span = Math.max(1, s.nextLevelXp - s.levelXp)
  const pct = Math.min(100, Math.round(((s.xp - s.levelXp) / span) * 100))
  const toNext = s.nextLevelXp - s.xp
  return (
    <div
      className="flex items-center gap-3 border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
      title={`${s.completed} gigs completed · ${s.xp} XP total (work ${s.breakdown.work} · personal ${s.breakdown.personal} · objectives ${s.breakdown.objectives}) · ${toNext} XP to level ${s.level + 1}`}
    >
      <span
        className="shrink-0 text-sm font-bold tracking-[0.1em] text-[var(--color-accent)]"
        style={{ textShadow: '0 0 10px var(--color-accent)' }}
      >
        LVL {s.level}
      </span>
      <div className="h-1.5 min-w-0 flex-1 bg-[var(--color-surface-2)]">
        <div
          className="h-full transition-all duration-500"
          style={{ width: `${pct}%`, backgroundColor: 'var(--color-accent)', boxShadow: '0 0 8px var(--color-accent)' }}
        />
      </div>
      <span className="shrink-0 font-mono text-[10px] text-[var(--color-text-faint)]">{s.xp - s.levelXp}/{span} xp</span>
    </div>
  )
}

// ── page ─────────────────────────────────────────────────────────────────────

export default function Gigs() {
  const gigs = useQuery({ queryKey: ['gigs'], queryFn: fetchGigs, refetchInterval: 30_000 })
  const [tab, setTab] = useState<Tab>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Deep link: /gigs?gig=<id> (from the command palette or a shared link)
  // preselects that gig, then the param is cleared so it doesn't stick.
  const [searchParams, setSearchParams] = useSearchParams()
  useEffect(() => {
    const g = searchParams.get('gig')
    if (g) { setSelectedId(g); setTab('all'); setSearchParams({}, { replace: true }) }
  }, [searchParams, setSearchParams])
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

  // Per-group collapse (client/category dropdowns); persisted by group key.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(GROUPS_KEY) ?? '[]') as string[]) }
    catch { return new Set() }
  })
  useEffect(() => { localStorage.setItem(GROUPS_KEY, JSON.stringify([...collapsedGroups])) }, [collapsedGroups])
  const toggleGroup = (key: string) => setCollapsedGroups((prev) => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })
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

  const [hideWaiting, setHideWaiting] = useState(() => localStorage.getItem(HIDE_WAITING_KEY) === '1')
  useEffect(() => { localStorage.setItem(HIDE_WAITING_KEY, hideWaiting ? '1' : '0') }, [hideWaiting])
  const [search, setSearch] = useState('')

  const groups = useMemo(() => {
    const built = buildGroups(gigs.data ?? [], tab, hideWaiting)
    const q = search.trim().toLowerCase()
    if (!q) return built
    // Filter within groups by title/section/client; drop groups left empty.
    return built
      .map((g) => ({ ...g, gigs: g.gigs.filter((x) => (x.title + ' ' + (x.section || '') + ' ' + g.title).toLowerCase().includes(q)) }))
      .filter((g) => g.gigs.length > 0)
  }, [gigs.data, tab, hideWaiting, search])
  const flat = useMemo(() => groups.flatMap((g) => g.gigs), [groups])
  const selected = flat.find((q) => q.id === selectedId) ?? flat[0] ?? null

  // When the container is too narrow for two panes, the journal stacks under
  // the list; bring it into view. Measured from the actual layout (works at
  // any zoom level) rather than a viewport media query.
  const selectGig = (id: string) => {
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
    const all = gigs.data ?? []
    const overdue = all.filter((q) => dueUrgency(splitDetail(q.detail).due, q.status) === 'overdue').length
    return {
      active: all.filter((q) => q.status === 'active').length,
      waiting: all.filter((q) => q.status === 'on_hold').length,
      done: all.filter((q) => q.status === 'completed').length,
      overdue,
    }
  }, [gigs.data])

  return (
    // @container: the pane split below reacts to the space this page actually
    // gets, not the viewport, so UI zoom / DPI scaling / small windows keep
    // the two-pane layout as long as it physically fits. Full width always:
    // the journal is the page, no reading-column cap.
    <div className="@container w-full space-y-5">
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-[0.35em] text-[var(--color-text-faint)]">// gig log</div>
          <h1 className="mt-1 whitespace-nowrap text-2xl font-bold tracking-[0.12em]" style={{ color: 'var(--color-accent)', textShadow: '0 0 16px var(--color-accent)' }}>
            gigs<span className="cursor-blink">_</span>
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <div className="hidden w-[220px] sm:block"><XpBar /></div>
          <div className="text-[13px] uppercase tracking-[0.18em] text-[var(--color-text-dim)]">
            [{counts.active} active · {counts.waiting} waiting · {counts.done} done]
            {counts.overdue > 0 && (
              <span className="ml-2 font-bold text-[var(--color-danger)]">{counts.overdue} overdue</span>
            )}
          </div>
        </div>
      </div>

      {/* category tabs, KCD2's shield strip */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-[var(--color-border)] pb-2">
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
        {/* Hide everything that's waiting on someone else (on-hold gigs). */}
        <button
          type="button"
          onClick={() => setHideWaiting((v) => !v)}
          title={hideWaiting ? 'Show gigs that are waiting on others' : 'Hide gigs that are waiting on others'}
          aria-pressed={hideWaiting}
          className={`ml-auto border px-3 py-1.5 text-xs uppercase tracking-[0.14em] transition ${
            hideWaiting
              ? 'border-[#7c9cc4]/70 bg-[rgba(124,156,196,0.1)] text-[#7c9cc4]'
              : 'border-[var(--color-border)] text-[var(--color-text-faint)] hover:text-[var(--color-text-dim)]'
          }`}
        >
          {hideWaiting ? '◼ waiting hidden' : '◼ hide waiting'}
        </button>
      </div>

      {gigs.isLoading ? (
        <div className="text-sm text-[var(--color-text-dim)]">loading…</div>
      ) : gigs.error ? (
        <div className="text-sm text-[var(--color-danger)]">gig log unavailable</div>
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
              title="Expand gig list"
              aria-label="Expand gig list"
              className="hidden self-stretch @2xl:mr-4 @2xl:flex @2xl:w-9 @2xl:shrink-0 @2xl:flex-col @2xl:items-center @2xl:gap-2 border border-[var(--color-border)] pt-2.5 text-[var(--color-text-dim)] transition hover:border-[var(--color-accent)]/60 hover:text-[var(--color-accent)]"
            >
              <ChevronsRight size={16} />
              <span className="text-[10px] uppercase tracking-[0.2em]" style={{ writingMode: 'vertical-rl' }}>
                gig list ({flat.length})
              </span>
            </button>
          )}

          {/* left: the gig list */}
          <div
            ref={listRef}
            className={`space-y-2 @2xl:w-[var(--listw)] @2xl:shrink-0 @2xl:max-h-[calc(100vh-230px)] @2xl:overflow-y-auto @2xl:pr-1 ${collapsed ? '@2xl:hidden' : ''}`}
          >
            <div className="flex gap-2">
              <div className="min-w-0 flex-1">
                <NewGigRow onCreated={(q) => setSelectedId(q.id)} />
              </div>
              <button
                type="button"
                onClick={() => setCollapsed(true)}
                title="Collapse gig list"
                aria-label="Collapse gig list"
                className="hidden shrink-0 items-center border border-[var(--color-border)] px-2 text-[var(--color-text-faint)] transition hover:border-[var(--color-accent)]/60 hover:text-[var(--color-accent)] @2xl:flex"
              >
                <ChevronsLeft size={16} />
              </button>
            </div>
            <div className="relative">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="filter gigs…"
                className="w-full border border-[var(--color-border)] bg-transparent px-2.5 py-1.5 pr-7 text-xs text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-border-strong)]"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  aria-label="Clear filter"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)] transition hover:text-[var(--color-text)]"
                >
                  <X size={13} />
                </button>
              )}
            </div>
            {flat.length === 0 && (
              <div className="px-1 py-4 text-sm text-[var(--color-text-dim)]">
                &gt; no gigs{tab !== 'all' ? ` (${tab})` : ''}. accept one above.
              </div>
            )}
            {groups.map((g) => {
              const groupCollapsed = collapsedGroups.has(g.key)
              // Nothing to do here if every gig in the group is waiting on
              // someone else: grey the header (steel) so it recedes.
              const allWaiting = g.gigs.length > 0 && g.gigs.every(isWaiting)
              return (
                <div key={g.key}>
                  <button
                    type="button"
                    onClick={() => toggleGroup(g.key)}
                    aria-expanded={!groupCollapsed}
                    title={allWaiting
                      ? `${g.title} — all waiting on others (nothing to do)`
                      : groupCollapsed ? `Expand ${g.title}` : `Collapse ${g.title}`}
                    className={`mb-1 flex w-full items-center gap-2 border-y px-3 py-1.5 text-[10px] uppercase tracking-[0.28em] transition ${
                      allWaiting
                        ? 'border-[var(--color-border)]/60 bg-transparent text-[#7c9cc4]/70 hover:text-[#7c9cc4]'
                        : 'border-[var(--color-border)] bg-[rgba(var(--color-accent-rgb),0.04)] text-[var(--color-text-dim)] hover:bg-[rgba(var(--color-accent-rgb),0.08)] hover:text-[var(--color-text)]'
                    }`}
                  >
                    {groupCollapsed ? <ChevronRight size={13} className="shrink-0" /> : <ChevronDown size={13} className="shrink-0" />}
                    <span className="min-w-0 flex-1 truncate text-left">{g.title}</span>
                    {allWaiting && <span className="shrink-0 text-[9px] tracking-[0.14em] text-[#7c9cc4]/70">waiting</span>}
                    <span className="shrink-0 text-[var(--color-text-faint)]">{g.gigs.length}</span>
                  </button>
                  {!groupCollapsed && (
                    <div className="space-y-0.5">
                      {g.gigs.map((q) => (
                        <GigListRow key={q.id} gig={q} selected={selected?.id === q.id} onSelect={() => selectGig(q.id)} />
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
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
              <GigJournal key={selected.id} gig={selected} />
            ) : (
              <div className="border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-10 text-center text-sm text-[var(--color-text-faint)]">
                &gt; select a gig to open its journal
              </div>
            )}
          </div>
        </div>
      )}
      <GigChat openGig={selected ? { id: selected.id, title: selected.title } : null} />
    </div>
  )
}
