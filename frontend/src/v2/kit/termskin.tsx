import { useEffect, useRef, type ReactNode } from 'react'
import {
  Bot, ChevronDown, FilePen, FilePlus, FileText, Globe, ListChecks, Search, SquareTerminal, Wrench,
  type LucideIcon,
} from 'lucide-react'
import { Press, cx } from './ui'
import { Icon } from './icons'
import { PHASE, type Act, type ActKind, type Phase, type Question } from './termscreen'

// The skin's drawn pieces (the state glyph, the question plates, the activity
// strip), shared by screens/Term.tsx and screens/Skin.tsx. What they show is
// read off the CLI's screen by termscreen.ts. Styles: screens/skin.css.

// ---------- the state, the question, the activity ----------

export function StateGlyph({ phase }: { phase: Phase }) {
  const s = PHASE[phase]
  return (
    <span className="vsk-sicon" data-p={phase} title={s.word}>
      <Icon name={s.icon} size={16} tone={s.tone} glow={s.glow} />
    </span>
  )
}

/** The question on screen as big plates: 1 is the lit one, the CLI's key hints ride along. */
export function Choices({ q, onPick }: { q: Question; onPick: (n: number) => void }) {
  const file = q.file.slice(Math.max(q.file.lastIndexOf('/'), q.file.lastIndexOf('\\')) + 1)
  return (
    <section className="vsk-ask" aria-label="Claude is asking">
      <header className="vsk-ask-head">
        <Icon name="asking" size={14} tone="acc2" glow />
        <span>{q.kind || 'Asking'}</span>
        {file && <b className="vl-ellipsis">{file}</b>}
      </header>
      <p className="vsk-ask-q">{q.text}</p>
      <div className="vsk-ask-opts" role="group" aria-label="Answers">
        {q.options.map((o, i) => (
          <Press
            key={o.n}
            className={cx('vsk-opt', i === 0 && 'vsk-opt-yes')}
            data-sel={o.sel || undefined}
            aria-label={`${o.n}. ${o.label}`}
            onPress={() => onPick(o.n)}
          >
            <b className="vsk-opt-n">{o.n}</b>
            <span className="vsk-opt-l">{o.label}</span>
            {o.hint && <kbd className="vsk-opt-k">{o.hint}</kbd>}
          </Press>
        ))}
      </div>
    </section>
  )
}

const KIND_ICON: Record<ActKind, LucideIcon> = {
  read: FileText, edit: FilePen, write: FilePlus, run: SquareTerminal, search: Search, web: Globe, agent: Bot, todo: ListChecks, tool: Wrench,
}
const KIND_VERB: Record<ActKind, string> = {
  read: 'Read', edit: 'Edit', write: 'Write', run: 'Run', search: 'Find', web: 'Fetch', agent: 'Agent', todo: 'Todo', tool: 'Tool',
}

function KindIcon({ kind, lit, size = 14 }: { kind: ActKind; lit?: boolean; size?: number }) {
  const C = KIND_ICON[kind]
  return <C size={size} strokeWidth={size <= 12 ? 1.8 : 1.6} className={cx('vl-icon', lit ? 'vl-icon-fg vl-icon-glow' : 'vl-icon-dim')} aria-hidden />
}

function actTarget(a: Act): { name: string; dir: string } {
  if (a.kind === 'read' || a.kind === 'edit' || a.kind === 'write') {
    const i = Math.max(a.arg.lastIndexOf('/'), a.arg.lastIndexOf('\\'))
    return i < 0 ? { name: a.arg, dir: '' } : { name: a.arg.slice(i + 1), dir: a.arg.slice(0, i) }
  }
  if (a.kind === 'search') {
    const p = /pattern:\s*"([^"]*)"/.exec(a.arg)
    const d = /path:\s*"([^"]*)"/.exec(a.arg)
    return { name: p ? `"${p[1]}"` : a.arg, dir: d?.[1] ?? '' }
  }
  return { name: a.arg || a.tool, dir: '' }
}

function actDetail(a: Act): ReactNode {
  if (a.state === 'run') return a.kind === 'todo' ? null : <span className="vsk-arow-run">running</span>
  if (a.state === 'no') return /rejected/i.test(a.detail) ? 'rejected' : 'stopped'
  switch (a.kind) {
    case 'read': {
      const n = /Read (\d+) lines?/.exec(a.detail)?.[1]
      return n ? `${n} lines` : a.detail
    }
    case 'edit':
    case 'write': {
      const add = /(\d+) additions?/.exec(a.detail)?.[1]
      const del = /(\d+) removals?/.exec(a.detail)?.[1]
      if (!add && !del) return 'saved'
      return (
        <>
          {add && <em className="vsk-add">+{add}</em>}
          {del && <em className="vsk-del">−{del}</em>}
        </>
      )
    }
    case 'search': {
      const m = /Found (\d+) (\w+)/.exec(a.detail)
      return m ? `${m[1]} ${m[2]}` : a.detail
    }
    case 'run':
      return a.detail === '(No content)' ? 'ok' : a.detail.length > 16 ? `${a.detail.slice(0, 15)}…` : a.detail
    default:
      return a.detail
  }
}

/** Tool calls as icon rows, newest last. Collapsed it is one line: the latest call. */
export function ActivityStrip({ acts, open, onToggle }: { acts: Act[]; open: boolean; onToggle: () => void }) {
  const listRef = useRef<HTMLOListElement>(null)
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [acts.length, open])
  const count = (k: ActKind[]) => acts.filter((a) => k.includes(a.kind)).length
  const parts = [
    [count(['read']), 'read'],
    [count(['edit', 'write']), 'edited'],
    [count(['run']), 'run'],
    [count(['search', 'web']), 'searched'],
  ].filter(([n]) => (n as number) > 0).map(([n, w]) => `${n} ${w}`)
  const last = acts[acts.length - 1]
  const lastT = last ? actTarget(last) : null
  return (
    <section className="vsk-act" data-open={open || undefined} aria-label="Activity">
      <Press className="vsk-act-head" aria-expanded={open} onPress={onToggle}>
        <Icon name="system" size={13} tone={last?.state === 'run' ? 'fg' : 'dim'} glow={last?.state === 'run'} />
        <span className="vsk-act-k">Activity</span>
        <span className="vsk-act-n">{parts.length ? parts.join(' · ') : 'none yet'}</span>
        {!open && last && lastT && (
          <span className="vsk-act-last">
            <KindIcon kind={last.kind} lit={last.state === 'run'} size={12} />
            <span className="vl-ellipsis">{lastT.name}</span>
          </span>
        )}
        <ChevronDown size={14} strokeWidth={1.6} className="vl-icon vl-icon-dim vsk-act-chev" aria-hidden />
      </Press>
      {open && (acts.length ? (
        <ol className="vsk-act-list" ref={listRef}>
          {acts.map((a) => {
            const t = actTarget(a)
            return (
              <li key={a.id} className="vsk-arow" data-s={a.state}>
                <KindIcon kind={a.kind} lit={a.state === 'run'} />
                <span className="vsk-arow-verb">{KIND_VERB[a.kind]}</span>
                <span className="vsk-arow-main">
                  <b>{t.name}</b>
                  {t.dir && <i>{t.dir}</i>}
                </span>
                <span className="vsk-arow-d">{actDetail(a)}</span>
              </li>
            )
          })}
        </ol>
      ) : (
        <p className="vsk-act-empty">Files Claude reads or edits, and the commands it runs, list here.</p>
      ))}
    </section>
  )
}
