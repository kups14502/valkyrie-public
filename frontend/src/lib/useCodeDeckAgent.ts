import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CodeDeckMessage } from './api'

// Live Code Deck session client. Connects to the persistent agent WebSocket,
// streams assistant text/tool-use/permission events, and exposes actions to
// answer permission prompts and interrupt the run.

export type AgentItem =
  | { kind: 'user'; key: string; text: string }
  | { kind: 'assistant'; key: string; text: string }
  | { kind: 'tool_use'; key: string; toolUseId?: string; name: string; input: unknown; result?: string; isError?: boolean }
  | { kind: 'permission'; key: string; requestId: string; tool: string; input: unknown; reason?: string; canAlways?: boolean; status: 'pending' | 'allow' | 'deny' }
  | { kind: 'system'; key: string; text: string }

type ServerEvent = {
  t: string
  text?: string
  id?: string
  at?: string
  toolUseId?: string
  name?: string
  input?: unknown
  isError?: boolean
  summary?: string
  requestId?: string
  tool?: string
  reason?: string
  canAlways?: boolean
  decision?: 'allow' | 'deny'
  always?: boolean
  value?: boolean
  message?: string
  costUsd?: number
  busy?: boolean
}

function wsBase() {
  const configured = import.meta.env.VITE_API_URL as string | undefined
  const base = configured || window.location.origin
  return base.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')
}

function seedFromHistory(rows: CodeDeckMessage[]): AgentItem[] {
  const items: AgentItem[] = []
  for (const r of rows) {
    let meta: Record<string, unknown> = {}
    try { meta = r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : {} } catch { /* ignore */ }
    if (r.role === 'user') items.push({ kind: 'user', key: r.id, text: r.content })
    else if (r.role === 'assistant') items.push({ kind: 'assistant', key: r.id, text: r.content })
    else if (meta.kind === 'tool_use') items.push({ kind: 'tool_use', key: r.id, toolUseId: meta.toolUseId as string, name: (meta.name as string) ?? 'tool', input: meta.input })
    else items.push({ kind: 'system', key: r.id, text: r.content })
  }
  return items
}

export type CodeDeckAgent = {
  items: AgentItem[]
  streaming: string
  thinking: boolean
  busy: boolean
  connected: boolean
  lastCostUsd?: number
  error?: string
  send: (text: string) => void
  resolvePermission: (requestId: string, decision: 'allow' | 'deny', always?: boolean) => void
  interrupt: () => void
}

export function useCodeDeckAgent(sessionId: string | null | undefined, enabled: boolean, history: CodeDeckMessage[]): CodeDeckAgent {
  const historyItems = useMemo(() => seedFromHistory(history), [history])
  const [live, setLive] = useState<AgentItem[]>([])
  const [streaming, setStreaming] = useState('')
  const [thinking, setThinking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [connected, setConnected] = useState(false)
  const [lastCostUsd, setLastCostUsd] = useState<number | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const wsRef = useRef<WebSocket | null>(null)
  const streamRef = useRef('')

  const flushStreaming = useCallback(() => { streamRef.current = ''; setStreaming('') }, [])

  useEffect(() => {
    if (!sessionId || !enabled) { setConnected(false); return }
    // Reset per-session live state.
    setLive([]); flushStreaming(); setThinking(false); setBusy(false); setLastCostUsd(undefined); setError(undefined)

    let stopped = false
    const ws = new WebSocket(`${wsBase()}/api/code-deck/agent-ws?sessionId=${encodeURIComponent(sessionId)}`)
    wsRef.current = ws
    ws.onopen = () => { if (!stopped) setConnected(true) }
    ws.onclose = () => { if (!stopped) setConnected(false) }
    ws.onerror = () => { if (!stopped) setConnected(false) }
    ws.onmessage = (event) => {
      let m: ServerEvent
      try { m = JSON.parse(String(event.data)) as ServerEvent } catch { return }
      switch (m.t) {
        case 'ready':
          if (typeof m.busy === 'boolean') setBusy(m.busy)
          break
        case 'busy':
          setBusy(Boolean(m.value))
          if (m.value) setError(undefined)
          break
        case 'user':
          setLive((prev) => prev.some((i) => i.key === m.id) ? prev : [...prev, { kind: 'user', key: m.id ?? crypto.randomUUID(), text: m.text ?? '' }])
          break
        case 'delta':
          setThinking(false)
          streamRef.current += m.text ?? ''
          setStreaming(streamRef.current)
          break
        case 'thinking':
          if (!streamRef.current) setThinking(true)
          break
        case 'assistant':
          flushStreaming(); setThinking(false)
          setLive((prev) => [...prev, { kind: 'assistant', key: m.id ?? crypto.randomUUID(), text: m.text ?? '' }])
          break
        case 'tool_use':
          flushStreaming()
          setLive((prev) => [...prev, { kind: 'tool_use', key: m.id ?? crypto.randomUUID(), toolUseId: m.toolUseId, name: m.name ?? 'tool', input: m.input }])
          break
        case 'tool_result':
          setLive((prev) => prev.map((i) => i.kind === 'tool_use' && i.toolUseId && i.toolUseId === m.toolUseId ? { ...i, result: m.summary, isError: m.isError } : i))
          break
        case 'permission':
          setLive((prev) => [...prev, { kind: 'permission', key: m.requestId ?? crypto.randomUUID(), requestId: m.requestId ?? '', tool: m.tool ?? 'tool', input: m.input, reason: m.reason, canAlways: m.canAlways, status: 'pending' }])
          break
        case 'permission_resolved':
          setLive((prev) => prev.map((i) => i.kind === 'permission' && i.requestId === m.requestId ? { ...i, status: m.decision ?? 'allow' } : i))
          break
        case 'result':
          if (typeof m.costUsd === 'number') setLastCostUsd(m.costUsd)
          break
        case 'error':
          setError(m.message)
          setBusy(false)
          break
        default:
          break
      }
    }
    return () => { stopped = true; ws.close(); wsRef.current = null }
  }, [sessionId, enabled, flushStreaming])

  const send = useCallback((text: string) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN || !text.trim()) return
    ws.send(JSON.stringify({ t: 'user', text: text.trim() }))
  }, [])

  const resolvePermission = useCallback((requestId: string, decision: 'allow' | 'deny', always = false) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ t: 'permission', requestId, decision, always }))
    setLive((prev) => prev.map((i) => i.kind === 'permission' && i.requestId === requestId ? { ...i, status: decision } : i))
  }, [])

  const interrupt = useCallback(() => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ t: 'interrupt' }))
  }, [])

  const items = useMemo(() => [...historyItems, ...live], [historyItems, live])
  return { items, streaming, thinking, busy, connected, lastCostUsd, error, send, resolvePermission, interrupt }
}
