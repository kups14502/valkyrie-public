import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, ChevronUp, Copy, Folder, GripVertical, PanelLeft, PanelLeftClose, Paperclip, Pencil, Pin, PinOff, Plus, Terminal, Trash2, X } from 'lucide-react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { Card } from '../components/Card'
import { Dropdown } from '../components/Dropdown'
import { Markdown } from '../components/Markdown'
import { QuestionCard } from '../components/QuestionCard'
import { createCodeDeckSession, deleteCodeDeckSession, fetchAIUsage, fetchCodeDeck, fetchCodeDeckMessages, updateCodeDeckPrefs, updateCodeDeckSession, uploadCodeDeckAttachment, type AIClientUsage, type AIUsage, type CodeDeckPrefs, type CodeDeckSession } from '../lib/api'
import { useCodeDeckAgent } from '../lib/useCodeDeckAgent'

const claudeModels = ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-haiku-4-5']
const codexModels = ['gpt-5.5']
const modelLabel = (m: string) => m.replace(/^claude-/, '')
// Reasoning effort levels. '' = default (let the model decide).
const effortLevels = ['', 'low', 'medium', 'high', 'xhigh', 'max']
const effortLabel = (e: string) => e || 'default'

// Sort `items` by the user-defined `order` (list of keys); unknown/new items fall
// back to alphabetical so they append in a stable, sensible position.
function applyOrder<T>(items: T[], order: string[] | undefined, keyOf: (t: T) => string): T[] {
  const idx = new Map((order ?? []).map((k, i) => [k, i] as const))
  return [...items].sort((a, b) => {
    const ai = idx.get(keyOf(a)) ?? Infinity
    const bi = idx.get(keyOf(b)) ?? Infinity
    return ai - bi || keyOf(a).localeCompare(keyOf(b))
  })
}

// Drag reorder: move `from` so it sits where `to` is (inserted before `to`),
// returning the new full ordering. Used by drag-and-drop reordering.
function reorder(keys: string[], from: string, to: string): string[] {
  if (from === to) return keys
  const arr = keys.filter((k) => k !== from)
  const idx = arr.indexOf(to)
  if (idx === -1) return keys
  arr.splice(idx, 0, from)
  return arr
}

// Touch-friendly reorder: swap `key` with its neighbour in direction `dir`
// (-1 up, +1 down). HTML5 drag events never fire for touch, so mobile drives
// reordering through up/down buttons that call this instead of the DnD handlers.
function moveInOrder(keys: string[], key: string, dir: -1 | 1): string[] {
  const i = keys.indexOf(key)
  if (i === -1) return keys
  const j = i + dir
  if (j < 0 || j >= keys.length) return keys
  const arr = [...keys]
  ;[arr[i], arr[j]] = [arr[j], arr[i]]
  return arr
}


const emailOf = (s: string) => s.match(/[\w.+-]+@[\w.-]+/)?.[0]?.toLowerCase()
const profileOrder = ['main-claude', 'botacct-claude', 'main-codex']
const orderedProfiles = (profiles: { id: string; label: string }[] = []) =>
  [...profiles].sort((a, b) => {
    const ai = profileOrder.indexOf(a.id)
    const bi = profileOrder.indexOf(b.id)
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi) || a.label.localeCompare(b.label)
  })

type UsageBarData = { label: string; pct: number; sub?: string; warn?: boolean }

function usageBarsForProfile(data: AIUsage | undefined, profile: { id: string; provider: string; label: string } | undefined): UsageBarData[] {
  if (!data || !profile) return []
  const wantEmail = profile.id === 'botacct-claude'
    ? 'bot@example.com'
    : profile.id === 'main-claude' || profile.id === 'main-codex'
    ? 'user@example.com'
    : emailOf(profile.label)
  const clients = data.aiClients ?? []
  if (profile.provider === 'claude') {
    const match = clients.find((c): c is Extract<AIClientUsage, { kind: 'claude' }> => c.kind === 'claude' && (!wantEmail || emailOf(c.label) === wantEmail))
    const quota = match?.quota ?? (wantEmail && emailOf('user@example.com') === wantEmail ? data.claude.quota : null)
    if (!quota) return []
    return [
      { label: 'Session (5h)', pct: quota.sessionPct, sub: quota.sessionResetsAt ? `Resets in ${Math.max(0, Math.round((new Date(quota.sessionResetsAt).getTime() - Date.now()) / 60000))} min` : quota.status?.replace(/_/g, ' ') ?? undefined },
      { label: 'Weekly', pct: quota.weeklyPct, sub: quota.weeklyResetsAt ? `Resets ${new Date(quota.weeklyResetsAt).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}` : undefined },
    ]
  }
  const match = clients.find((c): c is Extract<AIClientUsage, { kind: 'codex' }> => c.kind === 'codex')
  const rl = match?.rateLimits ?? data.codex.rateLimits
  const bars: UsageBarData[] = []
  if (rl.session5h) bars.push({ label: 'Session (5h)', pct: rl.session5h.pct, sub: `Resets in ${Math.max(0, Math.round((rl.session5h.resetsAt - Date.now() / 1000) / 60))} min` })
  if (rl.weekly) bars.push({ label: 'Weekly', pct: rl.weekly.pct })
  return bars
}

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

function SessionCard({ s, selected, onSelect, onPin, onDelete, drag, move }: { s: CodeDeckSession; selected: boolean; onSelect: () => void; onPin: () => void; onDelete: () => void; drag?: { onDragStart: () => void; onDragEnd: () => void; onDrop: () => void; dragging: boolean }; move?: { onUp: () => void; onDown: () => void; canUp: boolean; canDown: boolean } }) {
  return (
    <div
      draggable={Boolean(drag)}
      onDragStart={drag?.onDragStart}
      onDragEnd={drag?.onDragEnd}
      onDragOver={drag ? (e) => e.preventDefault() : undefined}
      onDrop={drag?.onDrop}
      className={drag?.dragging ? 'opacity-40' : ''}
    >
      <button type="button" onClick={onSelect} className={`flex w-full items-start gap-2 border p-3 text-left transition ${selected ? 'border-[var(--color-accent)] bg-[rgba(0,255,65,0.06)]' : 'border-[var(--color-border)] hover:border-[var(--color-border-strong)]'}`}>
        {drag && <GripVertical size={14} className="mt-0.5 hidden shrink-0 cursor-grab text-[var(--color-text-faint)] lg:block" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {s.pinned && <Pin size={12} className="shrink-0 text-[var(--color-accent)]" />}
            <div className="truncate text-sm font-semibold text-[var(--color-text)]">{s.title}</div>
          </div>
          <div className="mt-1 truncate text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-faint)]">{s.profileId} · {modelLabel(s.model)}{s.effort ? ` · ${s.effort}` : ''}</div>
          <div className="mt-1 truncate font-mono text-[10px] text-[var(--color-text-faint)]">{s.cwd}</div>
        </div>
        <div className="flex shrink-0 gap-1" onClick={(e) => e.stopPropagation()}>
          {move && (
            <div className="flex flex-col lg:hidden">
              <button type="button" onClick={move.onUp} disabled={!move.canUp} aria-label="Move up" className="border border-[var(--color-border)] px-1 text-[var(--color-text-dim)] hover:text-[var(--color-accent)] disabled:opacity-30"><ChevronUp size={11} /></button>
              <button type="button" onClick={move.onDown} disabled={!move.canDown} aria-label="Move down" className="border border-t-0 border-[var(--color-border)] px-1 text-[var(--color-text-dim)] hover:text-[var(--color-accent)] disabled:opacity-30"><ChevronDown size={11} /></button>
            </div>
          )}
          <button type="button" onClick={onPin} className="border border-[var(--color-border)] p-1 text-[var(--color-text-dim)] hover:text-[var(--color-accent)]">{s.pinned ? <PinOff size={12} /> : <Pin size={12} />}</button>
          <button type="button" onClick={onDelete} className="border border-[var(--color-border)] p-1 text-[var(--color-text-dim)] hover:text-[var(--color-danger)]"><Trash2 size={12} /></button>
        </div>
      </button>
    </div>
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
  const [effort, setEffort] = useState('')
  const [customPath, setCustomPath] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [renameText, setRenameText] = useState('')
  const [terminalState, setTerminalState] = useState<'idle' | 'connecting' | 'connected' | 'closed'>('idle')
  const [mode, setMode] = useState<'chat' | 'terminal'>('chat')
  const [chatInput, setChatInput] = useState('')
  const [uploadingFiles, setUploadingFiles] = useState<string[]>([])
  const [attached, setAttached] = useState<{ id: string; name: string; path: string; isImage: boolean; url?: string }[]>([])
  // toggledKeys flips an item's default collapsed state.
  // Default: user, tool_use, system, and resolved permissions are collapsed.
  //          assistant and pending permissions are expanded.
  const [toggledKeys, setToggledKeys] = useState<Set<string>>(new Set())
  const [metaLines, setMetaLines] = useState<string[]>([])
  const [detectedLinks, setDetectedLinks] = useState<string[]>([])
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [pinnedCollapsed, setPinnedCollapsed] = useState(false)
  const [foldersCollapsed, setFoldersCollapsed] = useState(false)
  const [sessionsCollapsed, setSessionsCollapsed] = useState(false)
  const [collapsedSessionFolders, setCollapsedSessionFolders] = useState<Set<string>>(new Set())
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  // Start with the sidebar closed on phones so the chat is immediately visible;
  // open by default on desktop. (There's a toggle button either way.)
  const [sidebarOpen, setSidebarOpen] = useState(() => typeof window === 'undefined' || window.innerWidth >= 1024)
  const [showNew, setShowNew] = useState(false)
  const [metaCollapsed, setMetaCollapsed] = useState(true)
  const [nowMs, setNowMs] = useState(Date.now())
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; title: string } | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const xtermRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const termDivRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const chatScrollRef = useRef<HTMLDivElement | null>(null)
  const linkBufRef = useRef('')
  const lastSendRef = useRef<{ text: string; at: number } | null>(null)

  const refresh = () => qc.invalidateQueries({ queryKey: ['code-deck'] })
  const create = useMutation({ mutationFn: createCodeDeckSession, onSuccess: (s) => { setSelectedId(s.id); setMode('chat'); setShowNew(false); void refresh() } })
  const update = useMutation({ mutationFn: ({ id, body }: { id: string; body: Partial<CodeDeckSession> }) => updateCodeDeckSession(id, body), onSuccess: () => { void refresh() } })
  const del = useMutation({ mutationFn: deleteCodeDeckSession, onSuccess: () => { setSelectedId(null); void refresh() } })
  const prefsMut = useMutation({ mutationFn: updateCodeDeckPrefs, onSuccess: () => { void refresh() } })

  const sessions = deck.data?.sessions ?? []
  const selected = sessions.find((s) => s.id === selectedId) ?? sessions[0] ?? null
  // History is loaded once per session for backlog; live updates arrive over the agent WebSocket.
  const messages = useQuery({ queryKey: ['code-deck-messages', selected?.id], queryFn: () => fetchCodeDeckMessages(selected!.id), enabled: Boolean(selected?.id) })
  const uploadAttachment = useMutation({
    mutationFn: ({ sessionId, file }: { sessionId: string; file: File }) => uploadCodeDeckAttachment(sessionId, file),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['code-deck-messages', selected?.id] }); void refresh() },
  })
  const prefs: CodeDeckPrefs = deck.data?.prefs ?? { groupOrder: [], projectOrder: {}, pinnedOrder: [] }
  const grouped = useMemo(() => {
    const out = new Map<string, CodeDeckSession[]>()
    for (const s of sessions) {
      if (!out.has(s.folder)) out.set(s.folder, [])
      out.get(s.folder)!.push(s)
    }
    return applyOrder(Array.from(out.entries()), prefs.groupOrder, ([name]) => name)
  }, [sessions, prefs.groupOrder])
  const projectGroups = useMemo(() => {
    const out = new Map<string, NonNullable<typeof deck.data>['projectRoots']>()
    for (const r of deck.data?.projectRoots ?? []) {
      if (!out.has(r.folder)) out.set(r.folder, [])
      out.get(r.folder)!.push(r)
    }
    return applyOrder(Array.from(out.entries()), prefs.groupOrder, ([name]) => name)
  }, [deck.data, prefs.groupOrder])
  const pinned = applyOrder(sessions.filter((s) => s.pinned), prefs.pinnedOrder, (s) => s.id)
  // Ordered list of folder-group names, used to drive group reordering.
  const groupNames = useMemo(() => applyOrder(Array.from(new Set(projectGroups.map(([n]) => n))), prefs.groupOrder, (n) => n), [projectGroups, prefs.groupOrder])

  // ----- drag-and-drop reorder -----
  // `drag` holds the item currently being dragged; drop handlers persist the new
  // order only when dropping onto a sibling of the same type/group.
  const [drag, setDrag] = useState<{ type: 'group' | 'project' | 'pinned'; group?: string; key: string } | null>(null)
  const dropGroup = (target: string) => { if (drag?.type === 'group') { prefsMut.mutate({ groupOrder: reorder(groupNames, drag.key, target) }); setDrag(null) } }
  const dropProject = (group: string, ordered: string[], target: string) => { if (drag?.type === 'project' && drag.group === group) { prefsMut.mutate({ projectOrder: { ...prefs.projectOrder, [group]: reorder(ordered, drag.key, target) } }); setDrag(null) } }
  const dropPinned = (target: string) => { if (drag?.type === 'pinned') { prefsMut.mutate({ pinnedOrder: reorder(pinned.map((s) => s.id), drag.key, target) }); setDrag(null) } }
  // Touch reorder (mobile up/down buttons) — same persistence as the DnD drops.
  const moveGroup = (name: string, dir: -1 | 1) => prefsMut.mutate({ groupOrder: moveInOrder(groupNames, name, dir) })
  const moveProject = (group: string, ordered: string[], name: string, dir: -1 | 1) => prefsMut.mutate({ projectOrder: { ...prefs.projectOrder, [group]: moveInOrder(ordered, name, dir) } })
  const movePinned = (id: string, dir: -1 | 1) => prefsMut.mutate({ pinnedOrder: moveInOrder(pinned.map((s) => s.id), id, dir) })

  // Close the mobile drawer after a navigation action. No-op on desktop, where
  // the sidebar is a persistent inline column rather than an overlay.
  const closeSidebarOnMobile = () => { if (typeof window !== 'undefined' && window.innerWidth < 1024) setSidebarOpen(false) }

  const openSession = (id: string) => {
    setSelectedId(id)
    setShowNew(false)
    closeSidebarOnMobile()
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

  const toggleGroup = (name: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const aiUsage = useQuery({ queryKey: ['ai-usage'], queryFn: fetchAIUsage, refetchInterval: 60_000 })

  const root = deck.data?.projectRoots.find((r) => r.id === rootId) ?? deck.data?.projectRoots[0]
  const profile = deck.data?.profiles.find((p) => p.id === profileId)
  const availableModels = profile?.provider === 'codex' ? codexModels : claudeModels

  const selectedProfile = deck.data?.profiles.find((p) => p.id === selected?.profileId)
  const selectedModels = selectedProfile?.provider === 'codex' ? codexModels : claudeModels
  const isClaudeProfile = selectedProfile ? selectedProfile.provider !== 'codex' : true
  const agent = useCodeDeckAgent(selected?.id ?? null, mode === 'chat' && Boolean(selected) && isClaudeProfile, messages.data ?? [])

  const changeProfile = (newProfileId: string) => {
    if (!selected) return
    const np = deck.data?.profiles.find((p) => p.id === newProfileId)
    if (!np) return
    // Provider is locked per session: Claude and codex are different engines with
    // incompatible session formats and cannot share a conversation, so switching
    // across providers mid-session is disallowed. Account/model changes within the
    // same provider are fine. (The dropdown only offers same-provider profiles;
    // this is the guard for any other code path.)
    if (selectedProfile && np.provider !== selectedProfile.provider) return
    const models = np.provider === 'codex' ? codexModels : claudeModels
    const newModel = models.includes(selected.model) ? selected.model : models[0]
    update.mutate({ id: selected.id, body: { profileId: newProfileId, model: newModel } })
  }
  const changeModel = (newModel: string) => {
    if (!selected) return
    update.mutate({ id: selected.id, body: { model: newModel } })
  }
  const changeEffort = (newEffort: string) => {
    if (!selected) return
    update.mutate({ id: selected.id, body: { effort: newEffort } })
  }
  // Picking a folder is inherently "where should work happen" — so selecting one
  // (even while inside a session) opens the New Session form pre-targeted at it,
  // rather than silently doing nothing or disrupting the current session's cwd.
  const selectRoot = (id: string) => { setRootId(id); setCustomPath(''); setShowNew(true); closeSidebarOnMobile() }
  const startRename = () => { if (selected) { setRenameText(selected.title); setRenaming(true) } }
  const commitRename = () => {
    if (!selected) { setRenaming(false); return }
    const t = renameText.trim()
    if (t && t !== selected.title) update.mutate({ id: selected.id, body: { title: t } })
    setRenaming(false)
  }

  // Match accounts/providers to usage clients from the dashboard feed.
  const usageBars = useMemo(() => usageBarsForProfile(aiUsage.data as AIUsage | undefined, selectedProfile), [aiUsage.data, selectedProfile])
  const newSessionUsageBars = useMemo(() => usageBarsForProfile(aiUsage.data as AIUsage | undefined, profile), [aiUsage.data, profile])
  const sessionUsage = usageBars.find((b) => b.label.toLowerCase().includes('session')) ?? usageBars[0]

  // An assistant turn can emit several text blocks (running commentary between
  // tool calls) plus the final answer — all rendered with a "claude" header.
  // Mark the last assistant block of each response (the one not followed by
  // another assistant block before the next user turn) so it reads as the end
  // of the response, not mid-thought.
  const finalAssistantKeys = useMemo(() => {
    const set = new Set<string>()
    const msgs = agent.items.filter((i) => i.kind === 'user' || i.kind === 'assistant' || i.kind === 'error')
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].kind !== 'assistant') continue
      const next = msgs[i + 1]
      if (!next || next.kind !== 'assistant') set.add(msgs[i].key)
    }
    // While a response is still streaming, the latest assistant block isn't final yet.
    if (agent.streaming || agent.busy) {
      const lastAssistant = [...msgs].reverse().find((m) => m.kind === 'assistant')
      if (lastAssistant) set.delete(lastAssistant.key)
    }
    return set
  }, [agent.items, agent.streaming, agent.busy])

  // Fold everything between a user prompt and the final response — intermediate
  // "thinking" commentary AND every tool call — into one collapsed activity block.
  // Only user turns, errors, and the FINAL assistant message of each response
  // stand on their own; the rest is grouped.
  type ActivityBlock = { kind: 'activity'; key: string; toolNames: string[]; hasThinking: boolean; items: import('../lib/useCodeDeckAgent').AgentItem[]; done: boolean }
  type DisplayItem = { kind: 'message'; item: import('../lib/useCodeDeckAgent').AgentItem } | ActivityBlock
  const displayItems = useMemo((): DisplayItem[] => {
    const result: DisplayItem[] = []
    let group: import('../lib/useCodeDeckAgent').AgentItem[] = []
    const flush = () => {
      if (!group.length) return
      const tools = group.filter((i) => i.kind === 'tool_use').map((i) => (i as { name: string }).name)
      const hasThinking = group.some((i) => i.kind === 'assistant')
      const done = group.every((i) => i.kind !== 'tool_use' || (i as { result?: string }).result !== undefined)
      result.push({ kind: 'activity', key: `act-${group[0].key}`, toolNames: tools, hasThinking, items: group, done })
      group = []
    }
    for (const it of agent.items) {
      const isFinalAssistant = it.kind === 'assistant' && finalAssistantKeys.has(it.key)
      // Questions stand alone too — a blocked picker must never hide inside a collapsed activity block.
      if (it.kind === 'user' || it.kind === 'error' || it.kind === 'question' || isFinalAssistant) { flush(); result.push({ kind: 'message', item: it }) }
      else group.push(it) // tools, system notices, AND intermediate "thinking" assistant text
    }
    flush()
    return result.map((item, idx) => {
      if (item.kind !== 'activity') return item
      const isLatest = idx === result.length - 1
      return { ...item, done: item.done || !agent.busy || !isLatest }
    })
  }, [agent.items, agent.busy, finalAssistantKeys])

  useEffect(() => {
    if (!availableModels.includes(model)) setModel(availableModels[0])
  }, [availableModels, model])

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const makeSession = () => {
    const custom = customPath.trim()
    const base = { title, profileId, model: availableModels.includes(model) ? model : availableModels[0], effort: profile?.provider === 'codex' ? '' : effort }
    const loc = custom
      ? { cwd: custom, folder: 'Custom', projectRootId: 'custom' }
      : { folder: root?.folder, projectRootId: rootId, cwd: root?.path }
    create.mutate({ ...base, ...loc })
  }
  const activeAgeSeconds = agent.lastEventAt ? Math.max(0, Math.floor((nowMs - agent.lastEventAt) / 1000)) : null
  const activeAgeLabel = activeAgeSeconds == null ? '' : activeAgeSeconds < 60 ? `${activeAgeSeconds}s` : `${Math.floor(activeAgeSeconds / 60)}m ${activeAgeSeconds % 60}s`
  const activeActivity = [...displayItems].reverse().find((item): item is ActivityBlock => item.kind === 'activity' && !item.done)
  const activeToolLabel = activeActivity?.toolNames.at(-1)
  const longQuiet = Boolean(agent.busy && activeAgeSeconds != null && activeAgeSeconds >= 300)
  const activeStatus = agent.thinking ? 'Thinking' : activeToolLabel ? `${activeToolLabel} running` : 'Working'

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
    if (!selected || !agent.connected || (!chatInput.trim() && attached.length === 0)) return
    const text = chatInput.trim()
    const now = Date.now()
    const dedupeKey = `${text}|${attached.map((a) => a.path).join(',')}`
    if (lastSendRef.current?.text === dedupeKey && now - lastSendRef.current.at < 1500) return
    lastSendRef.current = { text: dedupeKey, at: now }
    agent.send(text, attached.map((a) => a.path))
    setChatInput('')
    clearAttached()
  }

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const images = Array.from(e.clipboardData.items)
      .filter((item) => item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null)
    if (images.length > 0) {
      e.preventDefault()
      void uploadFiles(images)
    }
  }

  const uploadFiles = async (files: FileList | File[] | null) => {
    if (!selected || !files?.length) return
    const list = Array.from(files)
    setUploadingFiles(list.map((f) => f.name))
    try {
      for (const file of list) {
        const { attachment } = await uploadAttachment.mutateAsync({ sessionId: selected.id, file })
        const isImage = file.type.startsWith('image/')
        setAttached((prev) => [...prev, { id: `${file.name}-${file.size}-${prev.length}`, name: file.name, path: attachment.path, isImage, url: isImage ? URL.createObjectURL(file) : undefined }])
      }
    } finally {
      setUploadingFiles([])
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const removeAttached = (id: string) => {
    setAttached((prev) => {
      const hit = prev.find((a) => a.id === id)
      if (hit?.url) URL.revokeObjectURL(hit.url)
      return prev.filter((a) => a.id !== id)
    })
  }

  const clearAttached = () => {
    setAttached((prev) => {
      for (const a of prev) if (a.url) URL.revokeObjectURL(a.url)
      return []
    })
  }

  useEffect(() => {
    const el = chatScrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [agent.items.length, agent.streaming, agent.busy])

  // Clear the attachment tray (and free object URLs) when switching sessions.
  useEffect(() => {
    setAttached((prev) => {
      for (const a of prev) if (a.url) URL.revokeObjectURL(a.url)
      return []
    })
    setToggledKeys(new Set())
    setRenaming(false)
  }, [selected?.id])

  // Compute collapsed state directly from item kind/status — no effect needed.
  // Toggling flips the default.
  const isCollapsed = (it: import('../lib/useCodeDeckAgent').AgentItem): boolean => {
    const defaultCollapsed = it.kind === 'user' || it.kind === 'tool_use' || it.kind === 'system' ||
      (it.kind === 'permission' && it.status !== 'pending')
    return toggledKeys.has(it.key) ? !defaultCollapsed : defaultCollapsed
  }
  const toggleCollapsed = (key: string) => setToggledKeys((prev) => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next })

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
            {customPath.trim() ? <span className="block truncate text-[var(--color-accent)]">[Custom] {customPath.trim()}</span> : root ? <span className="block truncate">[{root.folder}] {root.label}</span> : <span className="text-[var(--color-text-faint)]">select a folder in the sidebar</span>}
          </div>
        </div>
        <button type="button" onClick={makeSession} disabled={create.isPending} className="mt-4 inline-flex items-center justify-center gap-2 border border-[var(--color-accent)] px-3 py-2 text-xs uppercase tracking-[0.14em] text-[var(--color-accent)] hover:bg-[rgba(0,255,65,0.08)] disabled:opacity-50"><Plus size={14} /> create</button>
      </div>
      <label className="mt-3 block min-w-0 space-y-1">
        <span className="text-[9px] uppercase tracking-[0.18em] text-[var(--color-text-faint)]">custom path (optional — overrides folder; must be under /home/brendon)</span>
        <input value={customPath} onChange={(e) => setCustomPath(e.target.value)} className="w-full min-w-0 border border-[var(--color-border)] bg-transparent px-3 py-2 font-mono text-sm outline-none focus:border-[var(--color-accent)]" placeholder="/home/brendon/some/folder" />
      </label>
      {create.error && <div className="mt-2 text-xs text-[var(--color-danger)]">{(create.error as Error).message}</div>}
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <label className="space-y-1">
          <span className="text-[9px] uppercase tracking-[0.18em] text-[var(--color-text-faint)]">account / engine</span>
          <Dropdown value={profileId} onChange={setProfileId} options={orderedProfiles(deck.data?.profiles).map((p) => ({ value: p.id, label: p.label }))} />
        </label>
        <label className="space-y-1">
          <span className="text-[9px] uppercase tracking-[0.18em] text-[var(--color-text-faint)]">model</span>
          <Dropdown value={availableModels.includes(model) ? model : availableModels[0]} onChange={setModel} options={availableModels.map((m) => ({ value: m, label: modelLabel(m) }))} />
        </label>
        {profile?.provider !== 'codex' && (
          <label className="space-y-1">
            <span className="text-[9px] uppercase tracking-[0.18em] text-[var(--color-text-faint)]">reasoning effort</span>
            <Dropdown value={effort} onChange={setEffort} options={effortLevels.map((e) => ({ value: e, label: effortLabel(e) }))} />
          </label>
        )}
      </div>
      <div className="mt-3 rounded border border-[var(--color-border)] bg-[rgba(255,255,255,0.02)] p-4">
        <div className="mb-3 text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-faint)]">usage for {profile?.label ?? 'selected account'}</div>
        {aiUsage.isLoading ? (
          <div className="text-sm text-[var(--color-text-dim)]">Loading usage…</div>
        ) : newSessionUsageBars.length > 0 ? (
          <div className="grid gap-4 md:grid-cols-2">{newSessionUsageBars.map((b) => <UsageBar key={b.label} pct={b.pct} label={b.label} sub={b.sub} warn={b.warn} />)}</div>
        ) : (
          <div className="text-sm text-[var(--color-text-dim)]">No usage data for this account yet.</div>
        )}
      </div>
    </Card>
  )

  return (
    <div className="flex min-w-0 max-w-full flex-col gap-4 lg:h-[calc(100dvh-150px)] lg:flex-row">
      {sidebarOpen && (
      <>
      {/* Mobile-only backdrop: tap outside the drawer to dismiss it. */}
      <div className="fixed inset-0 z-40 bg-black/60 lg:hidden" onClick={() => setSidebarOpen(false)} aria-hidden="true" />
      <aside className="fixed inset-y-0 left-0 z-50 w-[88%] max-w-[340px] space-y-4 overflow-auto border-r border-[var(--color-border)] bg-[var(--color-bg)] p-4 lg:static lg:z-auto lg:w-[320px] lg:max-w-none lg:shrink-0 lg:self-stretch lg:overflow-auto lg:border-r-0 lg:bg-transparent lg:p-0 lg:pr-1">
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
                <div className="space-y-2">{pinned.map((s, i) => <SessionCard key={s.id} s={s} selected={selected?.id === s.id} onSelect={() => openSession(s.id)} onPin={() => update.mutate({ id: s.id, body: { pinned: !s.pinned } })} onDelete={() => setConfirmDelete({ id: s.id, title: s.title })} drag={{ onDragStart: () => setDrag({ type: 'pinned', key: s.id }), onDragEnd: () => setDrag(null), onDrop: () => dropPinned(s.id), dragging: drag?.type === 'pinned' && drag.key === s.id }} move={{ onUp: () => movePinned(s.id, -1), onDown: () => movePinned(s.id, 1), canUp: i > 0, canDown: i < pinned.length - 1 }} />)}</div>
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
                        {!collapsed && <div className="space-y-2">{items.map((s) => <SessionCard key={s.id} s={s} selected={selected?.id === s.id} onSelect={() => openSession(s.id)} onPin={() => update.mutate({ id: s.id, body: { pinned: !s.pinned } })} onDelete={() => setConfirmDelete({ id: s.id, title: s.title })} />)}</div>}
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
                {projectGroups.map(([name, roots], gi) => {
                  // The synthetic group-root entry (id `group:<name>`) drives the
                  // group header itself; it is not shown as a separate row.
                  const groupRoot = roots.find((r) => r.id === `group:${name}`)
                  const parents = roots.filter((r) => !r.label.includes(' / ') && !r.id.startsWith('group:'))
                  const childrenByParent = new Map<string, typeof roots>()
                  for (const r of roots.filter((x) => x.label.includes(' / '))) {
                    const parent = r.label.split(' / ')[0]
                    if (!childrenByParent.has(parent)) childrenByParent.set(parent, [])
                    childrenByParent.get(parent)!.push(r)
                  }
                  const parentNames = new Set([...parents.map((r) => r.label), ...childrenByParent.keys()])
                  const groupCollapsed = collapsedGroups.has(name)
                  const orderedParentNames = applyOrder([...parentNames], prefs.projectOrder[name], (pn) => pn)
                  const groupSelected = Boolean(groupRoot && rootId === groupRoot.id)
                  return (
                    <div key={name} className="border-l border-[var(--color-accent)]/50 pl-3">
                      <div
                        draggable
                        onDragStart={() => setDrag({ type: 'group', key: name })}
                        onDragEnd={() => setDrag(null)}
                        onDragOver={drag?.type === 'group' ? (e) => e.preventDefault() : undefined}
                        onDrop={() => dropGroup(name)}
                        className={`mb-2 flex w-full items-center gap-1.5 ${drag?.type === 'group' && drag.key === name ? 'opacity-40' : ''}`}
                      >
                        <GripVertical size={13} className="hidden shrink-0 cursor-grab text-[var(--color-text-faint)] hover:text-[var(--color-accent)] lg:block" />
                        <div className="flex shrink-0 flex-col lg:hidden">
                          <button type="button" onClick={() => moveGroup(name, -1)} disabled={gi === 0} aria-label={`Move ${name} up`} className="border border-[var(--color-border)] px-1 text-[var(--color-text-dim)] hover:text-[var(--color-accent)] disabled:opacity-30"><ChevronUp size={11} /></button>
                          <button type="button" onClick={() => moveGroup(name, 1)} disabled={gi === projectGroups.length - 1} aria-label={`Move ${name} down`} className="border border-t-0 border-[var(--color-border)] px-1 text-[var(--color-text-dim)] hover:text-[var(--color-accent)] disabled:opacity-30"><ChevronDown size={11} /></button>
                        </div>
                        <button
                          type="button"
                          onClick={() => (groupRoot ? selectRoot(groupRoot.id) : toggleGroup(name))}
                          className={`flex flex-1 items-center gap-2 border px-2 py-1.5 text-xs font-bold uppercase tracking-[0.18em] transition ${groupSelected ? 'border-[var(--color-accent)] bg-[rgba(0,255,65,0.07)] text-[var(--color-accent)]' : 'border-transparent text-[var(--color-accent)] hover:border-[var(--color-border-strong)]'}`}
                          title={groupRoot ? `Run at ${groupRoot.path}` : undefined}
                        >
                          <Folder size={14} className="shrink-0" />
                          <span className="flex-1 text-left">{name}</span>
                        </button>
                        <button type="button" onClick={() => toggleGroup(name)} className="shrink-0 text-[var(--color-accent)] hover:opacity-80" aria-label={groupCollapsed ? `Expand ${name}` : `Collapse ${name}`}>
                          {groupCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                        </button>
                      </div>
                      {!groupCollapsed && <div className="space-y-1.5">
                        {orderedParentNames.map((parentName, pi) => {
                          const parentRoot = parents.find((r) => r.label === parentName)
                          const kids = childrenByParent.get(parentName) ?? []
                          const key = `${name}:${parentName}`
                          const open = expandedFolders.has(key)
                          return (
                            <div
                              key={key}
                              draggable
                              onDragStart={() => setDrag({ type: 'project', group: name, key: parentName })}
                              onDragEnd={() => setDrag(null)}
                              onDragOver={drag?.type === 'project' && drag.group === name ? (e) => e.preventDefault() : undefined}
                              onDrop={() => dropProject(name, orderedParentNames, parentName)}
                              className={`space-y-1.5 ${drag?.type === 'project' && drag.group === name && drag.key === parentName ? 'opacity-40' : ''}`}
                            >
                              <div className="flex items-stretch gap-1">
                                <GripVertical size={14} className="mt-2 hidden shrink-0 cursor-grab text-[var(--color-text-faint)] hover:text-[var(--color-accent)] lg:block" />
                                <div className="flex shrink-0 flex-col justify-center lg:hidden">
                                  <button type="button" onClick={() => moveProject(name, orderedParentNames, parentName, -1)} disabled={pi === 0} aria-label={`Move ${parentName} up`} className="border border-[var(--color-border)] px-1 text-[var(--color-text-dim)] hover:text-[var(--color-accent)] disabled:opacity-30"><ChevronUp size={11} /></button>
                                  <button type="button" onClick={() => moveProject(name, orderedParentNames, parentName, 1)} disabled={pi === orderedParentNames.length - 1} aria-label={`Move ${parentName} down`} className="border border-t-0 border-[var(--color-border)] px-1 text-[var(--color-text-dim)] hover:text-[var(--color-accent)] disabled:opacity-30"><ChevronDown size={11} /></button>
                                </div>
                                {kids.length > 0 ? (
                                  <button type="button" onClick={() => toggleFolder(key)} className="shrink-0 border border-[var(--color-border)] px-2 text-[var(--color-text-dim)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]" aria-label={open ? 'Collapse folder' : 'Expand folder'}>
                                    {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                                  </button>
                                ) : null}
                                <button
                                  type="button"
                                  onClick={() => parentRoot && selectRoot(parentRoot.id)}
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
                                      onClick={() => selectRoot(r.id)}
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
                      </div>}
                    </div>
                  )
                })}
              </div>}
            </Card>
      </aside>
      </>
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
                          {renaming ? (
                            <input
                              autoFocus
                              value={renameText}
                              onChange={(e) => setRenameText(e.target.value)}
                              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitRename() } if (e.key === 'Escape') setRenaming(false) }}
                              onBlur={commitRename}
                              className="min-w-0 flex-1 border border-[var(--color-accent)] bg-transparent px-2 py-0.5 text-base font-semibold text-[var(--color-text)] outline-none sm:text-xl"
                            />
                          ) : (
                            <>
                              <span className="truncate">{selected.title}</span>
                              <button type="button" onClick={startRename} className="shrink-0 text-[var(--color-text-faint)] hover:text-[var(--color-accent)]" aria-label="Rename session"><Pencil size={14} /></button>
                            </>
                          )}
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
                          <div className="flex flex-wrap items-end gap-2">
                            <label className="flex w-full flex-col gap-1 sm:w-56">
                              <span className="text-[9px] uppercase tracking-[0.18em] text-[var(--color-text-faint)]">account / engine</span>
                              <Dropdown size="sm" value={selected.profileId} onChange={changeProfile} options={orderedProfiles((deck.data?.profiles ?? []).filter((p) => p.provider === selectedProfile?.provider)).map((p) => ({ value: p.id, label: p.label }))} className="w-full" />
                            </label>
                            <label className="flex w-[calc(50%-0.25rem)] flex-col gap-1 sm:w-44">
                              <span className="text-[9px] uppercase tracking-[0.18em] text-[var(--color-text-faint)]">model</span>
                              <Dropdown size="sm" value={selectedModels.includes(selected.model) ? selected.model : selectedModels[0]} onChange={changeModel} options={selectedModels.map((m) => ({ value: m, label: modelLabel(m) }))} className="w-full" />
                            </label>
                            {isClaudeProfile && (
                              <label className="flex w-[calc(50%-0.25rem)] flex-col gap-1 sm:w-44">
                                <span className="text-[9px] uppercase tracking-[0.18em] text-[var(--color-text-faint)]">effort</span>
                                <Dropdown size="sm" value={selected.effort ?? ''} onChange={changeEffort} options={effortLevels.map((e) => ({ value: e, label: effortLabel(e) }))} className="w-full" />
                              </label>
                            )}
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
                        {!isClaudeProfile && (
                          <div className="rounded border border-[var(--color-warning)]/50 bg-[rgba(245,158,11,0.06)] p-3 text-xs text-[var(--color-warning)]">Live chat is Claude-only. Switch this session to a Claude profile, or use terminal mode for codex.</div>
                        )}
                        <div ref={chatScrollRef} className="min-h-[55vh] max-h-[62vh] flex-1 space-y-3 overflow-auto rounded border border-[var(--color-border)] bg-black/30 p-3 lg:min-h-[140px] lg:max-h-none">
                          {messages.isLoading ? <div className="text-sm text-[var(--color-text-dim)]">Loading chat…</div> : agent.items.length === 0 && !agent.streaming ? (
                            <div className="flex h-full items-start justify-center px-4 py-8 text-center text-sm text-[var(--color-text-dim)]">No chat history yet.</div>
                          ) : displayItems.map((di) => {
                            if (di.kind === 'activity') {
                              const collapsed = !toggledKeys.has(di.key)
                              // One collapsed block covering the work between prompt and answer:
                              // intermediate "thinking" commentary + every tool call.
                              const parts: string[] = []
                              if (di.hasThinking) parts.push('thinking')
                              if (di.toolNames.length) parts.push(...di.toolNames.slice(0, 6))
                              const label = parts.join(' · ') || 'context'
                              const toolCount = di.toolNames.length
                              return (
                                <div key={di.key} className="rounded border border-[var(--color-border)]/50 bg-[rgba(255,255,255,0.01)]">
                                  <button type="button" onClick={() => toggleCollapsed(di.key)} className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left">
                                    {collapsed ? <ChevronRight size={11} className="shrink-0 text-[var(--color-text-faint)]" /> : <ChevronDown size={11} className="shrink-0 text-[var(--color-text-faint)]" />}
                                    <span className="truncate font-mono text-[10px] text-[var(--color-text-faint)]">↳ {label}</span>
                                    {collapsed && toolCount > 0 && <span className="shrink-0 text-[9px] uppercase tracking-[0.14em] text-[var(--color-text-faint)]">{toolCount} step{toolCount === 1 ? '' : 's'}</span>}
                                    {!di.done && <span className={`ml-auto shrink-0 text-[9px] uppercase tracking-[0.14em] ${longQuiet ? 'text-[var(--color-warning)]' : 'text-[var(--color-accent)]'}`}>{longQuiet ? `waiting ${activeAgeLabel}` : `${activeToolLabel ?? 'running'} ${activeAgeLabel}`}</span>}
                                  </button>
                                  {!collapsed && (
                                    <div className="border-t border-[var(--color-border)]/40 px-3 pb-2 pt-2 space-y-2">
                                      {di.items.map((i) => {
                                        if (i.kind === 'assistant') {
                                          return <div key={i.key} className="border-l border-[var(--color-border)] pl-2 text-[11px] leading-relaxed text-[var(--color-text-dim)]"><Markdown>{i.text}</Markdown></div>
                                        }
                                        if (i.kind === 'tool_use') {
                                          const t = i as { key: string; name: string; result?: string; isError?: boolean }
                                          return <div key={t.key} className={`font-mono text-[11px] ${t.result === undefined ? 'text-[var(--color-text-faint)]' : t.isError ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-dim)]'}`}>🔧 {t.name}{t.result !== undefined ? (t.isError ? ' ✗' : ' ✓') : ' …'}</div>
                                        }
                                        if (i.kind === 'system') {
                                          return <div key={i.key} className="truncate font-mono text-[11px] text-[var(--color-text-faint)]">{i.text.split('\n')[0]}</div>
                                        }
                                        return null
                                      })}
                                    </div>
                                  )}
                                </div>
                              )
                            }

                            const it = di.item
                            const collapsed = isCollapsed(it)

                            if (it.kind === 'user') return (
                              <div key={it.key} className="rounded border border-[var(--color-accent)]/40 bg-[rgba(0,255,65,0.05)]">
                                <button type="button" onClick={() => toggleCollapsed(it.key)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
                                  {collapsed ? <ChevronRight size={12} className="shrink-0 text-[var(--color-accent)]/60" /> : <ChevronDown size={12} className="shrink-0 text-[var(--color-accent)]/60" />}
                                  <span className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-text-faint)]">you</span>
                                  {collapsed && <span className="ml-1 min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-dim)]">{it.text.split('\n')[0]}</span>}
                                </button>
                                {!collapsed && <div className="border-t border-[var(--color-accent)]/20 px-3 pb-3 pt-2 text-sm leading-relaxed text-[var(--color-text)] whitespace-pre-wrap break-words">{it.text}</div>}
                              </div>
                            )

                            if (it.kind === 'assistant') {
                              const isFinal = finalAssistantKeys.has(it.key)
                              return (
                              <div key={it.key} className={`rounded border bg-[rgba(255,255,255,0.02)] ${isFinal ? 'border-[var(--color-accent)]/60' : 'border-[var(--color-border)]'}`}>
                                <button type="button" onClick={() => toggleCollapsed(it.key)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
                                  {collapsed ? <ChevronRight size={12} className="shrink-0 text-[var(--color-text-faint)]" /> : <ChevronDown size={12} className="shrink-0 text-[var(--color-text-faint)]" />}
                                  <span className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-text-faint)]">claude</span>
                                  {isFinal
                                    ? <span className="shrink-0 rounded-sm bg-[rgba(0,255,65,0.12)] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em] text-[var(--color-accent)]">✓ response</span>
                                    : <span className="shrink-0 text-[9px] uppercase tracking-[0.14em] text-[var(--color-text-faint)]">· thinking</span>}
                                  {collapsed && <span className="ml-1 min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-dim)]">{it.text.split('\n')[0]}</span>}
                                </button>
                                {!collapsed && <div className="border-t border-[var(--color-border)] px-3 pb-3 pt-2"><Markdown>{it.text}</Markdown></div>}
                              </div>
                              )
                            }

                            if (it.kind === 'error') return (
                              <div key={it.key} className="rounded border border-[var(--color-danger)]/60 bg-[rgba(239,68,68,0.08)] px-3 py-2 text-sm leading-relaxed text-[var(--color-danger)] whitespace-pre-wrap break-words">⚠️ {it.text.replace(/^⚠️\s*/, '')}</div>
                            )

                            if (it.kind === 'question') return (
                              <QuestionCard
                                key={it.key}
                                item={it}
                                onAnswer={(picks) => agent.answerQuestion(it.requestId, picks)}
                                onCancel={() => agent.cancelQuestion(it.requestId)}
                              />
                            )

                            return null
                          })}
                          {agent.streaming && (
                            <div className="rounded border border-[var(--color-border)] bg-[rgba(255,255,255,0.02)] p-3">
                              <div className="mb-2 text-[10px] uppercase tracking-[0.16em] text-[var(--color-text-faint)]">assistant</div>
                              <div><Markdown>{agent.streaming}</Markdown><span className="cursor-blink">_</span></div>
                            </div>
                          )}
                          {agent.busy && !agent.streaming && (
                            <div className={`flex items-center gap-2 text-sm ${longQuiet ? 'text-[var(--color-warning)]' : 'text-[var(--color-accent)]'}`}>
                              <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
                              <span>{activeStatus}{activeAgeLabel ? ` · ${activeAgeLabel}` : ''}{longQuiet ? ' · no new events; still waiting on the tool/agent result' : ''}</span>
                            </div>
                          )}
                        </div>
                        <div className="shrink-0 space-y-2">
                          <textarea value={chatInput} onChange={(e) => setChatInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat() } }} onPaste={handlePaste} className="h-20 w-full resize-none border border-[var(--color-border)] bg-transparent px-3 py-2 text-sm text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)]" placeholder="Message Code Deck…" />
                          {attached.length > 0 && (
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-success)]">{attached.length} attached</span>
                              {attached.map((a) => (
                                <div key={a.id} className="flex items-center gap-2 border border-[var(--color-success)]/40 bg-[rgba(0,255,65,0.05)] py-1 pl-1 pr-2">
                                  {a.isImage && a.url
                                    ? <img src={a.url} alt={a.name} className="h-8 w-8 rounded object-cover" />
                                    : <span className="flex h-8 w-8 items-center justify-center text-[var(--color-text-dim)]"><Paperclip size={14} /></span>}
                                  <span className="max-w-[10rem] truncate text-[11px] text-[var(--color-text-dim)]">{a.name}</span>
                                  <button type="button" onClick={() => removeAttached(a.id)} className="text-[var(--color-text-faint)] hover:text-[var(--color-danger)]" aria-label={`remove ${a.name}`}><X size={12} /></button>
                                </div>
                              ))}
                            </div>
                          )}
                          {uploadingFiles.length > 0 && <div className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-accent)]">Uploading: {uploadingFiles.join(', ')}</div>}
                          {uploadAttachment.error && <div className="text-xs text-[var(--color-danger)]">{(uploadAttachment.error as Error).message}</div>}
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-3 text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-faint)]">
                              <span className="hidden sm:inline">Enter to send · Shift+Enter for newline</span>
                              <span className={agent.connected ? 'text-[var(--color-success)]' : 'text-[var(--color-text-faint)]'}>[{agent.connected ? 'live' : 'offline'}]</span>
                              {agent.busy && activeAgeLabel && <span className={longQuiet ? 'text-[var(--color-warning)]' : 'text-[var(--color-accent)]'}>{longQuiet ? `waiting ${activeAgeLabel}` : `${activeStatus.toLowerCase()} ${activeAgeLabel}`}</span>}
                              {typeof agent.lastCostUsd === 'number' && <span>${agent.lastCostUsd.toFixed(4)}</span>}
                            </div>
                            <div className="flex items-center gap-2">
                              <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(e) => { void uploadFiles(e.target.files) }} />
                              <button type="button" onClick={() => fileInputRef.current?.click()} disabled={uploadAttachment.isPending} className="inline-flex items-center gap-2 border border-[var(--color-border)] px-3 py-2 text-xs uppercase tracking-[0.14em] text-[var(--color-text-dim)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50"><Paperclip size={14} /> attach</button>
                              {agent.busy && (
                                <button type="button" onClick={() => agent.interrupt()} className="border border-[var(--color-danger)] px-4 py-2 text-xs uppercase tracking-[0.14em] text-[var(--color-danger)] hover:bg-[rgba(239,68,68,0.08)]">stop</button>
                              )}
                              <button type="button" onClick={sendChat} disabled={(!chatInput.trim() && attached.length === 0) || !agent.connected} className="border border-[var(--color-accent)] px-4 py-2 text-xs uppercase tracking-[0.14em] text-[var(--color-accent)] hover:bg-[rgba(0,255,65,0.08)] disabled:opacity-50">send</button>
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

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setConfirmDelete(null)}>
          <div className="w-full max-w-sm border border-[var(--color-danger)]/60 bg-black p-5 shadow-[0_0_40px_rgba(239,68,68,0.25)]" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 text-[10px] uppercase tracking-[0.18em] text-[var(--color-danger)]">delete session</div>
            <div className="mb-1 break-words text-sm text-[var(--color-text)]">Delete “{confirmDelete.title}”?</div>
            <div className="mb-4 text-xs text-[var(--color-text-dim)]">This removes the session and its chat history. This can’t be undone.</div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setConfirmDelete(null)} className="border border-[var(--color-border)] px-4 py-2 text-xs uppercase tracking-[0.14em] text-[var(--color-text-dim)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]">cancel</button>
              <button type="button" onClick={() => { del.mutate(confirmDelete.id); setConfirmDelete(null) }} className="border border-[var(--color-danger)] px-4 py-2 text-xs font-bold uppercase tracking-[0.14em] text-[var(--color-danger)] hover:bg-[rgba(239,68,68,0.1)]">delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
