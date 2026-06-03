import { useEffect, useMemo, useRef, useState } from 'react'
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
  const [terminalOutput, setTerminalOutput] = useState('')
  const [terminalInput, setTerminalInput] = useState('')
  const [terminalState, setTerminalState] = useState<'idle' | 'connecting' | 'connected' | 'closed'>('idle')
  const wsRef = useRef<WebSocket | null>(null)
  const terminalRef = useRef<HTMLPreElement | null>(null)

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

  useEffect(() => {
    terminalRef.current?.scrollTo({ top: terminalRef.current.scrollHeight })
  }, [terminalOutput])

  useEffect(() => () => {
    wsRef.current?.close()
  }, [])

  const wsBase = () => {
    const configured = import.meta.env.VITE_API_URL as string | undefined
    const base = configured || window.location.origin
    return base.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')
  }

  const startTerminal = () => {
    if (!selected) return
    wsRef.current?.close()
    setTerminalOutput('')
    setTerminalState('connecting')
    const ws = new WebSocket(`${wsBase()}/api/code-deck/ws?sessionId=${encodeURIComponent(selected.id)}&cols=120&rows=36`)
    wsRef.current = ws
    ws.onopen = () => setTerminalState('connected')
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as { type: string; data: string }
        if (msg.type === 'data') setTerminalOutput((v) => v + msg.data)
        else setTerminalOutput((v) => v + `\n// ${msg.data}\n`)
      } catch {
        setTerminalOutput((v) => v + String(event.data))
      }
    }
    ws.onerror = () => setTerminalOutput((v) => v + '\n// websocket error\n')
    ws.onclose = () => { setTerminalState('closed'); void refresh() }
  }

  const stopTerminal = () => {
    wsRef.current?.close()
    wsRef.current = null
    setTerminalState('closed')
  }

  const sendTerminalInput = () => {
    if (!terminalInput || terminalState !== 'connected') return
    wsRef.current?.send(JSON.stringify({ type: 'input', data: terminalInput + '\n' }))
    setTerminalInput('')
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(280px,360px)_minmax(420px,1fr)_minmax(280px,420px)] xl:items-start">
      <aside className="order-2 space-y-4 xl:sticky xl:top-24 xl:order-1 xl:self-start">
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

      <div className="order-1 space-y-6 xl:order-2 xl:col-span-2">
        <div className="flex items-end justify-between gap-4">
          <div>
            <div className="text-[9px] uppercase tracking-[0.35em] text-[var(--color-text-faint)]">// remote claude/codex workbench</div>
            <h1 className="mt-1 text-2xl font-bold tracking-[0.12em]" style={{ color: 'var(--color-accent)', textShadow: '0 0 16px var(--color-accent)' }}>code deck<span className="cursor-blink">_</span></h1>
          </div>
          <div className="text-xs uppercase tracking-[0.18em] text-[var(--color-text-dim)]">[{sessions.length} sessions · {pinned.length} pinned]</div>
        </div>

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
                    <div className="flex flex-wrap gap-2">
                      <button type="button" onClick={startTerminal} disabled={terminalState === 'connecting' || terminalState === 'connected'} className="inline-flex items-center gap-2 border border-[var(--color-accent)] px-3 py-2 text-xs uppercase tracking-[0.14em] text-[var(--color-accent)] hover:bg-[rgba(0,255,65,0.08)] disabled:opacity-50"><Terminal size={14} /> start terminal</button>
                      <button type="button" onClick={stopTerminal} disabled={terminalState !== 'connected'} className="inline-flex items-center gap-2 border border-[var(--color-border)] px-3 py-2 text-xs uppercase tracking-[0.14em] text-[var(--color-text-dim)] hover:border-[var(--color-warning)] hover:text-[var(--color-warning)] disabled:opacity-50">stop</button>
                      <button type="button" onClick={() => copy(selected.launchCommand)} className="inline-flex items-center gap-2 border border-[var(--color-border)] px-3 py-2 text-xs uppercase tracking-[0.14em] text-[var(--color-text-dim)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"><Copy size={14} /> copy command</button>
                    </div>
                    <div className="rounded border border-[var(--color-border)] bg-black/70 shadow-[0_0_35px_rgba(0,255,65,0.10)]">
                      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2 text-[10px] uppercase tracking-[0.16em] text-[var(--color-text-faint)]">
                        <span>// browser pty</span>
                        <span className={terminalState === 'connected' ? 'text-[var(--color-success)]' : terminalState === 'connecting' ? 'text-[var(--color-warning)]' : 'text-[var(--color-text-faint)]'}>[{terminalState}]</span>
                      </div>
                      <pre ref={terminalRef} className="h-[520px] overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed text-[var(--color-text)]">
                        {terminalOutput || 'terminal output will appear here…'}
                      </pre>
                      <div className="flex border-t border-[var(--color-border)]">
                        <input value={terminalInput} onChange={(e) => setTerminalInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') sendTerminalInput() }} disabled={terminalState !== 'connected'} className="min-w-0 flex-1 bg-transparent px-3 py-2 font-mono text-sm text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)] disabled:opacity-50" placeholder="type command/input and press Enter…" />
                        <button type="button" onClick={sendTerminalInput} disabled={terminalState !== 'connected'} className="border-l border-[var(--color-border)] px-3 py-2 text-xs uppercase tracking-[0.14em] text-[var(--color-accent)] disabled:opacity-50">send</button>
                      </div>
                    </div>
                    <div className="text-xs leading-relaxed text-[var(--color-text-dim)]">
                      This runs the selected Claude/Codex CLI through a server-side PTY over WebSocket. It bypasses OpenClaw; Master Control only organizes and hosts the terminal.
                    </div>
                  </div>
                )}
              </Card>
      </div>
    </div>
  )
}
