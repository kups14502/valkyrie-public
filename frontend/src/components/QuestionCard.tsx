import { useMemo, useState } from 'react'
import { Check, HelpCircle } from 'lucide-react'
import type { AgentItem, QuestionPick } from '../lib/useCodeDeckAgent'
import { Markdown } from './Markdown'

type QuestionItem = Extract<AgentItem, { kind: 'question' }>

// Interactive picker for an AskUserQuestion dialog. The agent is blocked
// waiting on this answer, so the card sits inline in the transcript with an
// accent border until the operator submits (or dismisses). Single-select
// questions behave like radios; multiSelect like checkboxes. Every question
// also gets a free-text "Other" box (AskUserQuestion always offers an
// implicit Other choice).
export function QuestionCard({ item, onAnswer, onCancel }: {
  item: QuestionItem
  onAnswer: (picks: QuestionPick[]) => void
  onCancel: () => void
}) {
  const pending = item.status === 'pending'
  // Per-question selection state, keyed by question index.
  const [selected, setSelected] = useState<Record<number, string[]>>({})
  const [other, setOther] = useState<Record<number, string>>({})

  const toggle = (qi: number, label: string, multi: boolean) => {
    setSelected((prev) => {
      const cur = prev[qi] ?? []
      if (multi) {
        return { ...prev, [qi]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] }
      }
      return { ...prev, [qi]: cur.includes(label) ? [] : [label] }
    })
  }

  const ready = useMemo(
    () => item.questions.every((_, qi) => (selected[qi]?.length ?? 0) > 0 || (other[qi]?.trim().length ?? 0) > 0),
    [item.questions, selected, other],
  )

  const submit = () => {
    if (!ready) return
    const picks: QuestionPick[] = item.questions.map((q, qi) => ({
      question: q.question,
      selected: selected[qi] ?? [],
      other: other[qi]?.trim() || undefined,
    }))
    onAnswer(picks)
  }

  // Resolved (answered/cancelled or seeded from history): show a compact summary.
  if (!pending) {
    const cancelled = item.status === 'cancelled'
    return (
      <div className="rounded border border-[var(--color-border)] bg-[rgba(255,255,255,0.02)]">
        <div className="flex items-center gap-2 px-3 py-2">
          <HelpCircle size={12} className="shrink-0 text-[var(--color-text-faint)]" />
          <span className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-text-faint)]">question</span>
          <span className={`shrink-0 rounded-sm px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em] ${cancelled ? 'bg-[rgba(239,68,68,0.12)] text-[var(--color-danger)]' : 'bg-[rgba(0,255,65,0.12)] text-[var(--color-accent)]'}`}>{cancelled ? 'dismissed' : '✓ answered'}</span>
        </div>
        {!cancelled && (
          <div className="space-y-2 border-t border-[var(--color-border)] px-3 pb-3 pt-2">
            {item.questions.map((q, qi) => (
              <div key={qi} className="text-xs">
                <div className="text-[var(--color-text-dim)]">{q.question}</div>
                <div className="mt-1 text-[var(--color-accent)]">→ {item.answers?.[q.question] || '—'}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="rounded border border-[var(--color-accent)]/60 bg-[rgba(0,255,65,0.04)] shadow-[0_0_25px_rgba(0,255,65,0.08)]">
      <div className="flex items-center gap-2 border-b border-[var(--color-accent)]/20 px-3 py-2">
        <HelpCircle size={13} className="shrink-0 text-[var(--color-accent)]" />
        <span className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-accent)]">claude is asking</span>
        <span className="ml-auto text-[9px] uppercase tracking-[0.14em] text-[var(--color-text-faint)]">awaiting your answer</span>
      </div>

      <div className="space-y-4 px-3 py-3">
        {item.questions.map((q, qi) => (
          <div key={qi} className="space-y-2">
            <div className="flex items-center gap-2">
              {q.header && <span className="shrink-0 rounded-sm bg-[rgba(0,255,65,0.12)] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em] text-[var(--color-accent)]">{q.header}</span>}
              {q.multiSelect && <span className="shrink-0 text-[9px] uppercase tracking-[0.14em] text-[var(--color-text-faint)]">select all that apply</span>}
            </div>
            <div className="text-sm leading-relaxed text-[var(--color-text)]"><Markdown>{q.question}</Markdown></div>
            <div className="space-y-1.5">
              {q.options.map((opt, oi) => {
                const isSel = (selected[qi] ?? []).includes(opt.label)
                return (
                  <button
                    key={oi}
                    type="button"
                    onClick={() => toggle(qi, opt.label, q.multiSelect)}
                    className={`flex w-full items-start gap-2 rounded border px-3 py-2 text-left transition-colors ${isSel ? 'border-[var(--color-accent)] bg-[rgba(0,255,65,0.08)]' : 'border-[var(--color-border)] hover:border-[var(--color-accent)]/50'}`}
                  >
                    <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border ${q.multiSelect ? 'rounded-sm' : 'rounded-full'} ${isSel ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-black' : 'border-[var(--color-text-faint)]'}`}>
                      {isSel && <Check size={11} strokeWidth={3} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-[var(--color-text)]">{opt.label}</span>
                      {opt.description && <span className="mt-0.5 block text-[11px] leading-relaxed text-[var(--color-text-dim)]">{opt.description}</span>}
                    </span>
                  </button>
                )
              })}
              <input
                type="text"
                value={other[qi] ?? ''}
                onChange={(e) => setOther((prev) => ({ ...prev, [qi]: e.target.value }))}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit() } }}
                placeholder="Other… (type a custom answer)"
                className="w-full border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)]"
              />
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-[var(--color-accent)]/20 px-3 py-2">
        <button type="button" onClick={onCancel} className="border border-[var(--color-border)] px-3 py-1.5 text-xs uppercase tracking-[0.14em] text-[var(--color-text-dim)] hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]">dismiss</button>
        <button type="button" onClick={submit} disabled={!ready} className="border border-[var(--color-accent)] px-4 py-1.5 text-xs uppercase tracking-[0.14em] text-[var(--color-accent)] hover:bg-[rgba(0,255,65,0.08)] disabled:opacity-40">submit answer</button>
      </div>
    </div>
  )
}
