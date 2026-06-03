import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Folder, Pin, PinOff, Plus, Terminal, Trash2 } from 'lucide-react'
import { Card } from '../components/Card'
import { createCodeDeckSession, deleteCodeDeckSession, fetchCodeDeck, updateCodeDeckSession, type CodeDeckSession } from '../lib/api'

const models = ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'gpt-5.5']

function SessionCard({ s, selected, onSelect, onPin, onDelete }: { s: CodeDeckSession; selected: boolean; onSelect: () => void; onPin: () => void; onDelete: () => void }) {
  return (
    <button type="button" onClick={onSelect} className={`w-full border p-3 text-left transition ${selected ? 'border-[var(--color-accent)] bg-[rgba(0,255,65,0.06)]' : 'border-[var(--color-border)] hover:border-[var(--color-border-strong)]'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {s.pinned && <Pin size={12} className="shrink-0 text-[var(--color-accent)]" />}
            <div className="truncate text-sm font-semibold text-[var(--color-text)]">{s.title}</div>
          </div>
          <div className="mt-1 truncate text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-faint)]">{s.profileId} · {s.model}</div>
          <div className="mt-1 truncate font-mono text-[10px] text-[var(--color-text-faint)]">{s.cwd}</div>
        </div>
        <div className="flex shrink-0 gap-1" onClick={(e) => e.stopPropagation()}>
          <button type="button" onClick={onPin} className="border border-[var(--color-border)] p-1 text-[var(--color-text-dim)] hover:text-[var(--color-accent)]">{s.pinned ? <PinOff size={12} /> : <Pin size={12} />}</button>
          <button type="button" onClick={onDelete} className="border border-[var(--color-border)] p-1 text-[var(--color-text-dim)] hover:text-[var(--color-danger)]"><Trash2 size={12} /></button>
        </div>
      </div>
    </button>
  )
}

export default function CodeDeck() {
  const qc = useQueryClient()
  const deck = useQuery({ queryKey: ['code-deck'], queryFn: fetchCodeDeck })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [folder, setFolder] = useState('work')
  const [title, setTitle] = useState('New Code Session')
  const [rootId, setRootId] = useState('work')
  const [profileId, setProfileId] = useState('main-claude')
  const [model, setModel] = useState('claude-sonnet-4-6')

  const refresh = () => qc.invalidateQueries({ queryKey: ['code-deck'] })
  const create = useMutation({ mutationFn: createCodeDeckSession, onSuccess: (s) => { setSelectedId(s.id); void refresh() } })
  const update = useMutation({ mutationFn: ({ id, body }: { id: string; body: Partial<CodeDeckSession> }) => updateCodeDeckSession(id, body), onSuccess: () => { void refresh() } })
  const del = useMutation({ mutationFn: deleteCodeDeckSession, onSuccess: () => { setSelectedId(null); void refresh() } })

  const sessions = deck.data?.sessions ?? []
  const selected = sessions.find((s) => s.id === selectedId) ?? sessions[0] ?? null
  const grouped = useMemo(() => {
    const out = new Map<string, CodeDeckSession[]>()
    for (const s of sessions) {
      if (!out.has(s.folder)) out.set(s.folder, [])
      out.get(s.folder)!.push(s)
    }
    return Array.from(out.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [sessions])
  const pinned = sessions.filter((s) => s.pinned)

  const root = deck.data?.projectRoots.find((r) => r.id === rootId)

  const makeSession = () => create.mutate({ title, folder, projectRootId: rootId, cwd: root?.path, profileId, model })
  const copy = async (text: string) => navigator.clipboard?.writeText(text)

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.35em] text-[var(--color-text-faint)]">remote claude/codex workbench</div>
          <h1 className="mt-2 text-3xl font-semibold tracking-[0.08em] text-[var(--color-text)]">Code Deck</h1>
        </div>
        <div className="text-xs uppercase tracking-[0.18em] text-[var(--color-text-dim)]">[{sessions.length} sessions · {pinned.length} pinned]</div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_420px]">
        <div className="space-y-6">
          <Card title="New session">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
              <input value={title} onChange={(e) => setTitle(e.target.value)} className="border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)] xl:col-span-2" />
              <input value={folder} onChange={(e) => setFolder(e.target.value)} className="border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]" placeholder="folder/client" />
              <select value={rootId} onChange={(e) => setRootId(e.target.value)} className="border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]">
                {(deck.data?.projectRoots ?? []).map((r) => <option key={r.id} value={r.id}>{r.label}{r.exists ? '' : ' (missing)'}</option>)}
              </select>
              <button type="button" onClick={makeSession} disabled={create.isPending} className="inline-flex items-center justify-center gap-2 border border-[var(--color-accent)] px-3 py-2 text-xs uppercase tracking-[0.14em] text-[var(--color-accent)] hover:bg-[rgba(0,255,65,0.08)] disabled:opacity-50"><Plus size={14} /> create</button>
            </div>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <select value={profileId} onChange={(e) => setProfileId(e.target.value)} className="border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]">
                {(deck.data?.profiles ?? []).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
              <select value={model} onChange={(e) => setModel(e.target.value)} className="border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]">
                {models.map((m) => <option key={m}>{m}</option>)}
              </select>
            </div>
          </Card>

          <Card title="Session console">
            {!selected ? (
              <div className="text-sm text-[var(--color-text-dim)]">Create or select a session.</div>
            ) : (
              <div className="space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 text-xl font-semibold text-[var(--color-text)]"><Terminal size={18} className="text-[var(--color-accent)]" />{selected.title}</div>
                    <div className="mt-1 text-xs text-[var(--color-text-dim)]">{selected.folder} · {selected.profileId} · {selected.model}</div>
                  </div>
                  <button type="button" onClick={() => update.mutate({ id: selected.id, body: { pinned: !selected.pinned } })} className="border border-[var(--color-border)] px-3 py-2 text-xs uppercase tracking-[0.14em] text-[var(--color-text-dim)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]">{selected.pinned ? 'unpin' : 'pin'}</button>
                </div>
                <div className="rounded border border-[var(--color-border)] bg-black/40 p-4 font-mono text-xs text-[var(--color-accent)] shadow-[0_0_30px_rgba(0,255,65,0.08)]">
                  <div className="text-[var(--color-text-faint)]">// launch command</div>
                  <pre className="mt-2 whitespace-pre-wrap break-all">{selected.launchCommand}</pre>
                </div>
                <button type="button" onClick={() => copy(selected.launchCommand)} className="inline-flex items-center gap-2 border border-[var(--color-border)] px-3 py-2 text-xs uppercase tracking-[0.14em] text-[var(--color-text-dim)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"><Copy size={14} /> copy command</button>
                <div className="text-xs leading-relaxed text-[var(--color-text-dim)]">
                  v0 is the organized session deck: folders, pins, profiles, project roots, and launch commands. Next step is wiring an interactive PTY/WebSocket terminal so this runs fully in-browser without OpenClaw.
                </div>
              </div>
            )}
          </Card>
        </div>

        <aside className="space-y-4 xl:sticky xl:top-24 xl:self-start">
          <Card title="Pinned">
            {pinned.length === 0 ? <div className="text-sm text-[var(--color-text-dim)]">No pinned sessions yet.</div> : <div className="space-y-2">{pinned.map((s) => <SessionCard key={s.id} s={s} selected={selected?.id === s.id} onSelect={() => setSelectedId(s.id)} onPin={() => update.mutate({ id: s.id, body: { pinned: !s.pinned } })} onDelete={() => confirm('Delete session?') && del.mutate(s.id)} />)}</div>}
          </Card>
          <Card title="Folders">
            {deck.isLoading ? <div className="text-sm text-[var(--color-text-dim)]">Loading…</div> : deck.error ? <div className="text-sm text-[var(--color-danger)]">Code Deck unavailable</div> : <div className="space-y-4">
              {grouped.map(([name, items]) => (
                <div key={name} className="border-l border-[var(--color-accent)]/50 pl-3">
                  <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-[var(--color-accent)]"><Folder size={14} /> {name}</div>
                  <div className="space-y-2">{items.map((s) => <SessionCard key={s.id} s={s} selected={selected?.id === s.id} onSelect={() => setSelectedId(s.id)} onPin={() => update.mutate({ id: s.id, body: { pinned: !s.pinned } })} onDelete={() => confirm('Delete session?') && del.mutate(s.id)} />)}</div>
                </div>
              ))}
              {sessions.length === 0 && <div className="text-sm text-[var(--color-text-dim)]">No sessions yet.</div>}
            </div>}
          </Card>
        </aside>
      </div>
    </div>
  )
}
