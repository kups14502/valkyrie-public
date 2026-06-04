import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Copy, Folder, PanelLeft, PanelLeftClose, Paperclip, Pin, PinOff, Plus, Terminal, Trash2, X } from 'lucide-react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { Card } from '../components/Card'
import { Dropdown } from '../components/Dropdown'
import { createCodeDeckSession, deleteCodeDeckSession, fetchAIUsage, fetchCodeDeck, fetchCodeDeckMessages, sendCodeDeckMessage, updateCodeDeckSession, uploadCodeDeckAttachment, type AIClientUsage, type AIUsage, type CodeDeckMessage, type CodeDeckSession } from '../lib/api'

const claudeModels = ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-haiku-4-5']
const codexModels = ['gpt-5.5']

const emailOf = (s: string) => s.match(/[\w.+-]+@[\w.-]+/)?.[0]?.toLowerCase()

function UsageBar({ pct, label, sub, warn }: { pct: number; label: string; sub?: string; warn?: boolean }) {
  const clamped = Math.max(0, Math.min(100, pct))
  const tone = warn || clamped >= 90 ? 'var(--color-danger)' : clamped >= 70 ? 'var(--color-warning)' : 'var(--color-accent)'
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3 text-xs uppercase tracking-[0.14em] text-[var(--color-text)]">
        <span className="truncate">{label}</span>
        <span className="shrink-0 font-semibold" style={{ color: tone }}>{Math.round(clamped)}%</span>
      </div>
      <div className="h-2.5 w-full overflow-hidden rounded bg-[rgba(255,255,255,0.08)]">
        <div className="h-full rounded" style={{ width: `${clamped}%`, background: tone, boxShadow: `0 0 10px ${tone}` }} />
      </div>
      {sub && <div className="text-[11px] text-[var(--color-text-dim)]">{sub}</div>}
    </div>
  )
}

function CompactUsageBar({ pct, label }: { pct: number; label: string }) {
  const clamped = Math.max(0, Math.min(100, pct))
  const tone = clamped >= 90 ? 'var(--color-danger)' : clamped >= 70 ? 'var(--color-warning)' : 'var(--color-accent)'
  return (
    <div className="hidden min-w-[220px] max-w-xl flex-1 items-center gap-3 sm:flex">
      <div className="shrink-0 text-[9px] uppercase tracking-[0.16em] text-[var(--color-text-faint)]">{label}</div>
      <div className="h-2 flex-1 overflow-hidden rounded bg-[rgba(255,255,255,0.08)]">
        <div className="h-full rounded" style={{ width: `${clamped}%`, background: tone, boxShadow: `0 0 10px ${tone}` }} />
      </div>
      <div className="shrink-0 text-[10px] font-semibold" style={{ color: tone }}>{Math.round(clamped)}%</div>
    </div>
  )
}

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
  const [title, setTitle] = useState('New Code Session')
  const [rootId, setRootId] = useState('work')
  const [profileId, setProfileId] = useState('main-claude')
  const [model, setModel] = useState('claude-sonnet-4-6')
  const [terminalState, setTerminalState] = useState<'idle' | 'connecting' | 'connected' | 'closed'>('idle')
  const [mode, setMode] = useState<'chat' | 'terminal'>('chat')
  const [chatInput, setChatInput] = useState('')
  const [uploadingFiles, setUploadingFiles] = useState<string[]>([])
  const [metaLines, setMetaLines] = useState<string[]>([])
  const [detectedLinks, setDetectedLinks] = useState<string[]>([])
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [pinnedCollapsed, setPinnedCollapsed] = useState(false)
  const [foldersCollapsed, setFoldersCollapsed] = useState(false)
  const [sessionsCollapsed, setSessionsCollapsed] = useState(false)
  const [collapsedSessionFolders, setCollapsedSessionFolders] = useState<Set<string>>(new Set())
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [showNew, setShowNew] = useState(false)
  const [metaCollapsed, setMetaCollapsed] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const xtermRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const termDivRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const linkBufRef = useRef('')

  const refresh = () => qc.invalidateQueries({ queryKey: ['code-deck'] })
  const create = useMutation({ mutationFn: createCodeDeckSession, onSuccess: (s) => { setSelectedId(s.id); setMode('chat'); setShowNew(false); void refresh() } })
  const update = useMutation({ mutationFn: ({ id, body }: { id: string; body: Partial<CodeDeckSession> }) => updateCodeDeckSession(id, body), onSuccess: () => { void refresh() } })
  const del = useMutation({ mutationFn: deleteCodeDeckSession, onSuccess: () => { setSelectedId(null); void refresh() } })

  const sessions = deck.data?.sessions ?? []
  const selected = sessions.find((s) => s.id === selectedId) ?? sessions[0] ?? null
  const messages = useQuery({ queryKey: ['code-deck-messages', selected?.id], queryFn: () => fetchCodeDeckMessages(selected!.id), enabled: Boolean(selected?.id), refetchInterval: 5000 })
  const chat = useMutation({
    mutationFn: ({ sessionId, content }: { sessionId: string; content: string }) => sendCodeDeckMessage(sessionId, content),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['code-deck-messages', selected?.id] }); void refresh() },
  })
  const uploadAttachment = useMutation({
    mutationFn: ({ sessionId, file }: { sessionId: string; file: File }) => uploadCodeDeckAttachment(sessionId, file),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['code-deck-messages', selected?.id] }); void refresh() },
  })
  const grouped = useMemo(() => {
    const out = new Map<string, CodeDeckSession[]>()
    for (const s of sessions) {
      if (!out.has(s.folder)) out.set(s.folder, [])
      out.get(s.folder)!.push(s)
    }
    return Array.from(out.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [sessions])
  const projectGroups = useMemo(() => {
    const out = new Map<string, NonNullable<typeof deck.data>['projectRoots']>()
    for (const r of deck.data?.projectRoots ?? []) {
      if (!out.has(r.folder)) out.set(r.folder, [])
      out.get(r.folder)!.push(r)
    }
    return Array.from(out.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [deck.data])
  const pinned = sessions.filter((s) => s.pinned)

  const openSession = (id: string) => {
    setSelectedId(id)
    setShowNew(false)
  }

  const toggleFolder = (key: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleSessionFolder = (key: string) => {
    setCollapsedSessionFolders((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const aiUsage = useQuery({ queryKey: ['ai-usage'], queryFn: fetchAIUsage, refetchInterval: 60_000 })

  const root = deck.data?.projectRoots.find((r) => r.id === rootId) ?? deck.data?.projectRoots[0]
  const profile = deck.data?.profiles.find((p) => p.id === profileId)
  const availableModels = profile?.provider === 'codex' ? codexModels : claudeModels

  const selectedProfile = deck.data?.profiles.find((p) => p.id === selected?.profileId)
  const selectedModels = selectedProfile?.provider === 'codex' ? codexModels : claudeModels

  const changeProfile = (newProfileId: string) => {
    if (!selected) return
    const np = deck.data?.profiles.find((p) => p.id === newProfileId)
    const models = np?.provider === 'codex' ? codexModels : claudeModels
    const newModel = models.includes(selected.model) ? selected.model : models[0]
    update.mutate({ id: selected.id, body: { profileId: newProfileId, model: newModel } })
  }
  const changeModel = (newModel: string) => {
    if (!selected) return
    update.mutate({ id: selected.id, body: { model: newModel } })
  }

  // Match the selected session's account/provider to a usage client from the dashboard feed.
  const usageBars = useMemo(() => {
    const data = aiUsage.data as AIUsage | undefined
    if (!data || !selectedProfile) return [] as { label: string; pct: number; sub?: string; warn?: boolean }[]
    const provider = selectedProfile.provider
    const wantEmail = selectedProfile.id === 'botacct-claude'
      ? 'bot@example.com'
      : selectedProfile.id === 'main-claude' || selectedProfile.id === 'main-codex'
      ? 'user@example.com'
      : emailOf(selectedProfile.label)
    const clients = data.aiClients ?? []
    if (provider === 'claude') {
      const match = clients.find((c): c is Extract<AIClientUsage, { kind: 'claude' }> => c.kind === 'claude' && (!wantEmail || emailOf(c.label) === wantEmail))
      const quota = match?.quota ?? (wantEmail && emailOf('user@example.com') === wantEmail ? data.claude.quota : null)
      if (!quota) return []
      const bars: { label: string; pct: number; sub?: string; warn?: boolean }[] = []
      bars.push({ label: 'Session (5h)', pct: quota.sessionPct, sub: quota.sessionResetsAt ? `Resets in ${Math.max(0, Math.round((new Date(quota.sessionResetsAt).getTime() - Date.now()) / 60000))} min` : quota.status?.replace(/_/g, ' ') ?? undefined })
      bars.push({ label: 'Weekly', pct: quota.weeklyPct, sub: quota.weeklyResetsAt ? `Resets ${new Date(quota.weeklyResetsAt).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}` : undefined })
      return bars
    }
    const match = clients.find((c): c is Extract<AIClientUsage, { kind: 'codex' }> => c.kind === 'codex')
    const rl = match?.rateLimits ?? data.codex.rateLimits
    const bars: { label: string; pct: number; sub?: string; warn?: boolean }[] = []
    if (rl.session5h) bars.push({ label: 'Session (5h)', pct: rl.session5h.pct, sub: `Resets in ${Math.max(0, Math.round((rl.session5h.resetsAt - Date.now() / 1000) / 60))} min` })
    if (rl.weekly) bars.push({ label: 'Weekly', pct: rl.weekly.pct })
    return bars
  }, [aiUsage.data, selectedProfile])
  const sessionUsage = usageBars.find((b) => b.label.toLowerCase().includes('session')) ?? usageBars[0]

  useEffect(() => {
    if (!availableModels.includes(model)) setModel(availableModels[0])
  }, [availableModels, model])

  const makeSession = () => create.mutate({ title, folder: root?.folder, projectRootId: rootId, cwd: root?.path, profileId, model: availableModels.includes(model) ? model : availableModels[0] })

  const stripAnsi = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b[()][A-Za-z0-9]/g, '').replace(/\r/g, '')
  const captureLinks = (text: string) => {
    // Accumulate stripped text in a rolling buffer (keep last 4KB) so URLs
    // split across multiple WebSocket packets get joined before the regex runs.
    linkBufRef.current = (linkBufRef.current + stripAnsi(text)).slice(-4096)
    const buf = linkBufRef.current.replace(/\n/g, '')
    const matches = buf.match(/https?:\/\/[^\s\]"'<>]+/g) ?? []
    if (matches.length === 0) return
    setDetectedLinks((prev) => {
      const next = [...prev]
      for (const raw of matches) {
        const url = raw.replace(/[.,;:)]+$/, '')
        if (url.length > 20 && !next.includes(url)) next.push(url)
      }
      return next.slice(-8)
    })
  }
  const copyText = async (text: string) => navigator.clipboard?.writeText(text)

  // Mount xterm.js when the terminal div is visible
  useEffect(() => {
    if (!termDivRef.current) return
    if (xtermRef.current) return

    const term = new XTerm({
      theme: {
        background: '#000000',
        foreground: '#00ff41',
        cursor: '#00ff41',
        selectionBackground: 'rgba(0,255,65,0.3)',
      },
      fontFamily: '"Fira Mono", "JetBrains Mono", monospace',
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(termDivRef.current)
    fit.fit()
    xtermRef.current = term
    fitRef.current = fit

    term.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'input', data }))
      }
    })

    const ro = new ResizeObserver(() => { fit.fit() })
    ro.observe(termDivRef.current)

    return () => {
      ro.disconnect()
      term.dispose()
      xtermRef.current = null
      fitRef.current = null
    }
  }, [mode])  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { wsRef.current?.close() }, [])

  const wsBase = () => {
    const configured = import.meta.env.VITE_API_URL as string | undefined
    const base = configured || window.location.origin
    return base.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')
  }

  const startTerminal = (sessionId = selected?.id) => {
    if (!sessionId) return
    wsRef.current?.close()
    xtermRef.current?.clear()
    setMetaLines([])
    setDetectedLinks([])
    linkBufRef.current = ''
    setTerminalState('connecting')
    const term = xtermRef.current
    const cols = term?.cols ?? 220
    const rows = term?.rows ?? 50
    const ws = new WebSocket(`${wsBase()}/api/code-deck/ws?sessionId=${encodeURIComponent(sessionId)}&cols=${cols}&rows=${rows}`)
    wsRef.current = ws
    ws.onopen = () => setTerminalState('connected')
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as { type: string; data: string }
        if (msg.type === 'data') {
          captureLinks(msg.data)
          xtermRef.current?.write(msg.data)
        } else {
          captureLinks(msg.data)
          setMetaLines((v) => [...v, msg.data])
        }
      } catch {
        xtermRef.current?.write(String(event.data))
      }
    }
    ws.onerror = () => setMetaLines((v) => [...v, 'websocket error'])
    ws.onclose = () => { setTerminalState('closed'); void refresh() }
  }

  const stopTerminal = () => {
    wsRef.current?.close()
    wsRef.current = null
    setTerminalState('closed')
  }

  const sendChat = () => {
    if (!selected || !chatInput.trim() || chat.isPending) return
    chat.mutate({ sessionId: selected.id, content: chatInput.trim() })
    setChatInput('')
  }

  const uploadFiles = async (files: FileList | null) => {
    if (!selected || !files?.length) return
    const list = Array.from(files)
    setUploadingFiles(list.map((f) => f.name))
    try {
      for (const file of list) await uploadAttachment.mutateAsync({ sessionId: selected.id, file })
    } finally {
      setUploadingFiles([])
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const messageTone = (role: CodeDeckMessage['role']) => role === 'user' ? 'border-[var(--color-accent)]/40 bg-[rgba(0,255,65,0.05)]' : role === 'assistant' ? 'border-[var(--color-border)] bg-[rgba(255,255,255,0.02)]' : 'border-[var(--color-warning)]/40 bg-[rgba(245,158,11,0.05)]'

  const newSessionForm = (
    <Card title="New session">
      <div className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5">
        <label className="min-w-0 space-y-1 xl:col-span-2">
          <span className="text-[9px] uppercase tracking-[0.18em] text-[var(--color-text-faint)]">session name</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} className="w-full min-w-0 border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]" placeholder="New code session" />
        </label>
        <div className="min-w-0 space-y-1 xl:col-span-2">
          <span className="text-[9px] uppercase tracking-[0.18em] text-[var(--color-text-faint)]">selected server folder</span>
          <div className="min-w-0 overflow-hidden border border-[var(--color-border)] bg-[rgba(255,255,255,0.02)] px-3 py-2 text-sm text-[var(--color-text)]">
            {root ? <span className="block truncate">[{root.folder}] {root.label}</span> : <span className="text-[var(--color-text-faint)]">select a folder in the sidebar</span>}
          </div>
        </div>
        <button type="button" onClick={makeSession} disabled={create.isPending} className="mt-4 inline-flex items-center justify-center gap-2 border border-[var(--color-accent)] px-3 py-2 text-xs uppercase tracking-[0.14em] text-[var(--color-accent)] hover:bg-[rgba(0,255,65,0.08)] disabled:opacity-50"><Plus size={14} /> create</button>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <label className="space-y-1">
          <span className="text-[9px] uppercase tracking-[0.18em] text-[var(--color-text-faint)]">account / engine</span>
          <Dropdown value={profileId} onChange={setProfileId} options={(deck.data?.profiles ?? []).map((p) => ({ value: p.id, label: p.label }))} />
        </label>
        <label className="space-y-1">
          <span className="text-[9px] uppercase tracking-[0.18em] text-[var(--color-text-faint)]">model</span>
          <Dropdown value={availableModels.includes(model) ? model : availableModels[0]} onChange={setModel} options={availableModels.map((m) => ({ value: m, label: m }))} />
        </label>
      </div>
    </Card>
  )

  return (
    <div className="flex min-w-0 max-w-full gap-4 lg:h-[calc(100dvh-150px)]">
      {sidebarOpen && (
      <aside className="w-full shrink-0 space-y-4 lg:w-[320px] lg:self-stretch lg:overflow-auto lg:pr-1">
            <div className="flex gap-2">
              <button type="button" onClick={() => { setShowNew(true); setSelectedId(null) }} className="inline-flex flex-1 items-center justify-center gap-2 border border-[var(--color-accent)] px-3 py-2 text-xs uppercase tracking-[0.14em] text-[var(--color-accent)] hover:bg-[rgba(0,255,65,0.08)]"><Plus size={14} /> new</button>
              <button type="button" onClick={() => setSidebarOpen(false)} className="shrink-0 border border-[var(--color-border)] px-2 text-[var(--color-text-dim)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]" aria-label="Collapse sidebar"><PanelLeftClose size={16} /></button>
            </div>
            <Card>
              <button type="button" onClick={() => setPinnedCollapsed((v) => !v)} className="mb-4 flex w-full items-center justify-between gap-2 border-b border-[var(--color-border)] pb-2 text-left text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--color-accent)] hover:text-[var(--color-accent)]" style={{ textShadow: '0 0 8px var(--color-accent)' }} aria-label={pinnedCollapsed ? 'Expand pinned section' : 'Collapse pinned section'}>
                <span className="truncate">&gt; Pinned <span className="text-[var(--color-text-faint)]">({pinned.length})</span></span>
                {pinnedCollapsed ? <ChevronRight size={13} className="shrink-0" /> : <ChevronDown size={13} className="shrink-0" />}
              </button>
              {pinnedCollapsed ? (
                <div className="text-sm text-[var(--color-text-dim)]">{pinned.length} pinned hidden.</div>
              ) : pinned.length === 0 ? (
                <div className="text-sm text-[var(--color-text-dim)]">No pinned sessions yet.</div>
              ) : (
                <div className="space-y-2">{pinned.map((s) => <SessionCard key={s.id} s={s} selected={selected?.id === s.id} onSelect={() => openSession(s.id)} onPin={() => update.mutate({ id: s.id, body: { pinned: !s.pinned } })} onDelete={() => confirm('Delete session?') && del.mutate(s.id)} />)}</div>
              )}
            </Card>
            <Card>
              <button type="button" onClick={() => setSessionsCollapsed((v) => !v)} className="mb-4 flex w-full items-center justify-between gap-2 border-b border-[var(--color-border)] pb-2 text-left text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--color-accent)] hover:text-[var(--color-accent)]" style={{ textShadow: '0 0 8px var(--color-accent)' }} aria-label={sessionsCollapsed ? 'Expand sessions section' : 'Collapse sessions section'}>
                <span className="truncate">&gt; Sessions <span className="text-[var(--color-text-faint)]">({sessions.length})</span></span>
                {sessionsCollapsed ? <ChevronRight size={13} className="shrink-0" /> : <ChevronDown size={13} className="shrink-0" />}
              </button>
              {sessionsCollapsed ? (
                <div className="text-sm text-[var(--color-text-dim)]">{sessions.length} sessions hidden.</div>
              ) : grouped.length === 0 ? (
                <div className="text-sm text-[var(--color-text-dim)]">No sessions yet.</div>
              ) : (
                <div className="space-y-4">
                  {grouped.map(([name, items]) => {
                    const collapsed = collapsedSessionFolders.has(name)
                    return (
                      <div key={`sessions-${name}`} className="border-l border-[var(--color-border)] pl-3">
                        <button type="button" onClick={() => toggleSessionFolder(name)} className="mb-2 flex w-full items-center justify-between gap-2 text-left text-xs font-bold uppercase tracking-[0.18em] text-[var(--color-text-dim)] hover:text-[var(--color-accent)]" aria-label={collapsed ? `Expand ${name} sessions` : `Collapse ${name} sessions`}>
                          <span className="truncate">{name} <span className="text-[var(--color-text-faint)]">({items.length})</span></span>
                          {collapsed ? <ChevronRight size={13} className="shrink-0" /> : <ChevronDown size={13} className="shrink-0" />}
                        </button>
                        {!collapsed && <div className="space-y-2">{items.map((s) => <SessionCard key={s.id} s={s} selected={selected?.id === s.id} onSelect={() => openSession(s.id)} onPin={() => update.mutate({ id: s.id, body: { pinned: !s.pinned } })} onDelete={() => confirm('Delete session?') && del.mutate(s.id)} />)}</div>}
                      </div>
                    )
                  })}
                </div>
              )}
            </Card>
            <Card>
              <button type="button" onClick={() => setFoldersCollapsed((v) => !v)} className="mb-4 flex w-full items-center justify-between gap-2 border-b border-[var(--color-border)] pb-2 text-left text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--color-accent)] hover:text-[var(--color-accent)]" style={{ textShadow: '0 0 8px var(--color-accent)' }} aria-label={foldersCollapsed ? 'Expand folders section' : 'Collapse folders section'}>
                <span className="truncate">&gt; Folders</span>
                {foldersCollapsed ? <ChevronRight size={13} className="shrink-0" /> : <ChevronDown size={13} className="shrink-0" />}
              </button>
              {foldersCollapsed ? (
                <div className="text-sm text-[var(--color-text-dim)]">Folders hidden.</div>
              ) : deck.isLoading ? <div className="text-sm text-[var(--color-text-dim)]">Loading…</div> : deck.error ? <div className="text-sm text-[var(--color-danger)]">Code Deck unavailable</div> : <div className="space-y-5">
                {projectGroups.map(([name, roots]) => {
                  const parents = roots.filter((r) => !r.label.includes(' / '))
                  const childrenByParent = new Map<string, typeof roots>()
                  for (const r of roots.filter((x) => x.label.includes(' / '))) {
                    const parent = r.label.split(' / ')[0]
                    if (!childrenByParent.has(parent)) childrenByParent.set(parent, [])
                    childrenByParent.get(parent)!.push(r)
                  }
                  const parentNames = new Set([...parents.map((r) => r.label), ...childrenByParent.keys()])
                  return (
                    <div key={name} className="border-l border-[var(--color-accent)]/50 pl-3">
                      <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-[var(--color-accent)]"><Folder size={14} /> {name}</div>
                      <div className="space-y-1.5">
                        {[...parentNames].sort().map((parentName) => {
                          const parentRoot = parents.find((r) => r.label === parentName)
                          const kids = childrenByParent.get(parentName) ?? []
                          const key = `${name}:${parentName}`
                          const open = expandedFolders.has(key)
                          return (
                            <div key={key} className="space-y-1.5">
                              <div className="flex gap-1">
                                {kids.length > 0 ? (
                                  <button type="button" onClick={() => toggleFolder(key)} className="shrink-0 border border-[var(--color-border)] px-2 text-[var(--color-text-dim)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]" aria-label={open ? 'Collapse folder' : 'Expand folder'}>
                                    {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                                  </button>
                                ) : null}
                                <button
                                  type="button"
                                  onClick={() => parentRoot && setRootId(parentRoot.id)}
                                  className={`min-w-0 flex-1 border px-3 py-2 text-left text-xs transition ${parentRoot && rootId === parentRoot.id ? 'border-[var(--color-accent)] bg-[rgba(0,255,65,0.07)] text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-text-dim)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]'}`}
                                >
                                  <div className="truncate font-semibold">{parentName}</div>
                                  {parentRoot && <div className="truncate font-mono text-[10px] text-[var(--color-text-faint)]">{parentRoot.path}</div>}
                                </button>
                              </div>
                              {open && kids.length > 0 && (
                                <div className="ml-7 space-y-1.5 border-l border-[var(--color-border)] pl-2">
                                  {kids.map((r) => (
                                    <button
                                      key={r.id}
                                      type="button"
                                      onClick={() => setRootId(r.id)}
                                      className={`w-full border px-3 py-2 text-left text-xs transition ${rootId === r.id ? 'border-[var(--color-accent)] bg-[rgba(0,255,65,0.07)] text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-text-dim)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]'}`}
                                    >
                                      <div className="truncate font-semibold">{r.label.replace(`${parentName} / `, '')}</div>
                                      <div className="truncate font-mono text-[10px] text-[var(--color-text-faint)]">{r.path}</div>
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>}
            </Card>
      </aside>
      )}

      <div className="flex min-w-0 flex-1 flex-col gap-4 lg:min-h-0">
        {!(selected && !showNew && metaCollapsed) && (
        <div className="flex min-w-0 flex-wrap items-end justify-between gap-4">
          <div className="flex items-center gap-3">
            {!sidebarOpen && (
              <button type="button" onClick={() => setSidebarOpen(true)} className="shrink-0 border border-[var(--color-border)] px-2 py-2 text-[var(--color-text-dim)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]" aria-label="Open sidebar"><PanelLeft size={16} /></button>
            )}
            <div>
              <div className="text-[9px] uppercase tracking-[0.35em] text-[var(--color-text-faint)]">// remote claude/codex workbench</div>
              <h1 className="mt-1 text-2xl font-bold tracking-[0.12em]" style={{ color: 'var(--color-accent)', textShadow: '0 0 16px var(--color-accent)' }}>code deck<span className="cursor-blink">_</span></h1>
            </div>
          </div>
          <div className="text-xs uppercase tracking-[0.18em] text-[var(--color-text-dim)]">[{sessions.length} sessions · {pinned.length} pinned ]</div>
        </div>
        )}

              {(showNew || !selected) ? (
                <div className="space-y-3 lg:min-h-0 lg:flex-1 lg:overflow-auto">
                  {selected && (
                    <button type="button" onClick={() => setShowNew(false)} className="inline-flex items-center gap-2 border border-[var(--color-border)] px-3 py-2 text-xs uppercase tracking-[0.14em] text-[var(--color-text-dim)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"><X size={14} /> back to chat</button>
                  )}
                  {newSessionForm}
                </div>
              ) : (
              <div className="panel flex max-w-full flex-col overflow-hidden p-4 sm:p-5 lg:min-h-0 lg:flex-1">
                {(
                  <div className="flex min-h-0 flex-1 flex-col gap-4">
                    <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] pb-3">
                      <div className="flex min-w-0 flex-1 items-center gap-4">
                        <div className="flex min-w-0 items-center gap-2 text-base font-semibold text-[var(--color-text)] sm:text-xl">
                          {!sidebarOpen && (
                            <button type="button" onClick={() => setSidebarOpen(true)} className="shrink-0 border border-[var(--color-border)] px-1.5 py-1.5 text-[var(--color-text-dim)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]" aria-label="Open sidebar"><PanelLeft size={15} /></button>
                          )}
                          <Terminal size={18} className="shrink-0 text-[var(--color-accent)]" />
                          <span className="truncate">{selected.title}</span>
                        </div>
                        {metaCollapsed && sessionUsage && <CompactUsageBar pct={sessionUsage.pct} label={sessionUsage.label} />}
                      </div>
                      <button type="button" onClick={() => setMetaCollapsed((v) => !v)} className="shrink-0 inline-flex items-center gap-2 text-left text-xs font-bold uppercase tracking-[0.18em] text-[var(--color-text-dim)] hover:text-[var(--color-accent)]" aria-label={metaCollapsed ? 'Expand session account settings' : 'Collapse session account settings'}>
                        <span className="hidden sm:inline">account / model</span>
                        {metaCollapsed ? <ChevronRight size={14} className="shrink-0" /> : <ChevronDown size={14} className="shrink-0" />}
                      </button>
                    </div>
                    {!metaCollapsed && (
                    <div className="space-y-3 border-b border-[var(--color-border)] pb-3">
                      <div className="grid gap-3 lg:grid-cols-[minmax(260px,auto)_minmax(0,1fr)] lg:items-stretch">
                        <div className="min-w-0 space-y-3 lg:max-w-[520px]">
                          <div className="flex flex-wrap items-center gap-2">
                            <Dropdown size="sm" value={selected.profileId} onChange={changeProfile} options={(deck.data?.profiles ?? []).map((p) => ({ value: p.id, label: p.label }))} className="w-56" />
                            <Dropdown size="sm" value={selectedModels.includes(selected.model) ? selected.model : selectedModels[0]} onChange={changeModel} options={selectedModels.map((m) => ({ value: m, label: m }))} className="w-44" />
                            <button type="button" onClick={() => update.mutate({ id: selected.id, body: { pinned: !selected.pinned } })} className="shrink-0 border border-[var(--color-border)] px-3 py-1.5 text-xs uppercase tracking-[0.14em] text-[var(--color-text-dim)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]">{selected.pinned ? 'unpin' : 'pin'}</button>
                          </div>
                          <div className="flex items-center gap-2 font-mono text-[10px] text-[var(--color-text-dim)]"><Folder size={12} className="shrink-0 text-[var(--color-accent)]" /><span className="truncate">{selected.cwd}</span></div>
                          <div className="flex flex-wrap gap-2">
                            <button type="button" onClick={() => setMode('chat')} className={`border px-3 py-2 text-xs uppercase tracking-[0.14em] ${mode === 'chat' ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-text-dim)]'}`}>chat</button>
                            <button type="button" onClick={() => setMode('terminal')} className={`border px-3 py-2 text-xs uppercase tracking-[0.14em] ${mode === 'terminal' ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-text-dim)]'}`}>terminal</button>
                          </div>
                        </div>
                        {usageBars.length > 0 && (
                          <div className="w-full min-w-0 space-y-4 rounded border border-[var(--color-border)] bg-[rgba(255,255,255,0.02)] p-4 text-left">
                            {usageBars.map((b) => <UsageBar key={b.label} pct={b.pct} label={b.label} sub={b.sub} warn={b.warn} />)}
                          </div>
                        )}
                      </div>
                    </div>
                    )}

                    {mode === 'chat' ? (
                      <div className="flex min-h-0 flex-1 flex-col gap-4">
                        <div className="min-h-[140px] flex-1 space-y-3 overflow-auto rounded border border-[var(--color-border)] bg-black/30 p-3">
                          {messages.isLoading ? <div className="text-sm text-[var(--color-text-dim)]">Loading chat…</div> : (messages.data ?? []).length === 0 ? (
                            <div className="flex h-full items-start justify-center px-4 py-8 text-center text-sm text-[var(--color-text-dim)]">No chat history yet.</div>
                          ) : (messages.data ?? []).map((m) => (
                            <div key={m.id} className={`rounded border p-3 ${messageTone(m.role)}`}>
                              <div className="mb-2 text-[10px] uppercase tracking-[0.16em] text-[var(--color-text-faint)]">{m.role} · {new Date(m.createdAt).toLocaleString()}</div>
                              <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-[var(--color-text)]">{m.content}</div>
                            </div>
                          ))}
                          {chat.isPending && <div className="text-sm text-[var(--color-accent)]">Thinking/running…</div>}
                          {chat.error && <div className="text-sm text-[var(--color-danger)]">{(chat.error as Error).message}</div>}
                        </div>
                        <div className="shrink-0 space-y-2">
                          <textarea value={chatInput} onChange={(e) => setChatInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat() } }} className="h-20 w-full resize-none border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)]" placeholder="Message Code Deck…" />
                          {uploadingFiles.length > 0 && <div className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-accent)]">Uploading: {uploadingFiles.join(', ')}</div>}
                          {uploadAttachment.error && <div className="text-xs text-[var(--color-danger)]">{(uploadAttachment.error as Error).message}</div>}
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-faint)]">Enter to send · Shift+Enter for newline</div>
                            <div className="flex items-center gap-2">
                              <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(e) => { void uploadFiles(e.target.files) }} />
                              <button type="button" onClick={() => fileInputRef.current?.click()} disabled={uploadAttachment.isPending} className="inline-flex items-center gap-2 border border-[var(--color-border)] px-3 py-2 text-xs uppercase tracking-[0.14em] text-[var(--color-text-dim)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50"><Paperclip size={14} /> attach</button>
                              <button type="button" onClick={sendChat} disabled={!chatInput.trim() || chat.isPending} className="border border-[var(--color-accent)] px-4 py-2 text-xs uppercase tracking-[0.14em] text-[var(--color-accent)] hover:bg-[rgba(0,255,65,0.08)] disabled:opacity-50">send</button>
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="flex min-h-0 flex-1 flex-col gap-4">
                        <div className="flex flex-wrap gap-2">
                          {terminalState !== 'connected' && terminalState !== 'connecting' && (
                            <button type="button" onClick={() => startTerminal()} className="inline-flex items-center gap-2 border border-[var(--color-accent)] px-3 py-2 text-xs uppercase tracking-[0.14em] text-[var(--color-accent)] hover:bg-[rgba(0,255,65,0.08)]"><Terminal size={14} /> start terminal</button>
                          )}
                          <button type="button" onClick={stopTerminal} disabled={terminalState !== 'connected'} className="inline-flex items-center gap-2 border border-[var(--color-border)] px-3 py-2 text-xs uppercase tracking-[0.14em] text-[var(--color-text-dim)] hover:border-[var(--color-warning)] hover:text-[var(--color-warning)] disabled:opacity-50">stop</button>
                        </div>
                        {metaLines.length > 0 && (
                          <div className="space-y-0.5 font-mono text-[10px] text-[var(--color-text-faint)]">
                            {metaLines.map((l, i) => <div key={i}>// {l}</div>)}
                          </div>
                        )}
                        {detectedLinks.length > 0 && (
                          <div className="space-y-2 rounded border border-[var(--color-border)] bg-[rgba(0,255,65,0.04)] p-3">
                            <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-accent)]">detected links</div>
                            {detectedLinks.map((url) => (
                              <div key={url} className="flex min-w-0 items-center gap-2">
                                <a href={url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--color-text)] underline decoration-[var(--color-accent)]/50 underline-offset-4">{url}</a>
                                <button type="button" onClick={() => copyText(url)} className="shrink-0 border border-[var(--color-border)] p-1 text-[var(--color-text-dim)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]" aria-label="Copy link"><Copy size={13} /></button>
                              </div>
                            ))}
                          </div>
                        )}
                        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded border border-[var(--color-border)] bg-black shadow-[0_0_35px_rgba(0,255,65,0.10)]">
                          <div className="flex shrink-0 items-center justify-between border-b border-[var(--color-border)] px-3 py-2 text-[10px] uppercase tracking-[0.16em] text-[var(--color-text-faint)]">
                            <span>// browser pty</span>
                            <span className={terminalState === 'connected' ? 'text-[var(--color-success)]' : terminalState === 'connecting' ? 'text-[var(--color-warning)]' : 'text-[var(--color-text-faint)]'}>[{terminalState}]</span>
                          </div>
                          <div ref={termDivRef} className="min-h-[200px] w-full flex-1" />
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
              )}
      </div>
    </div>
  )
}
