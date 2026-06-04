import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CodeDeckMessage } from './api'

// Live Code Deck session client. Connects to the persistent agent WebSocket,
// streams assistant text/tool-use/permission events, and exposes actions to
// answer permission prompts and interrupt the run.
//
// Reconnect: if the socket drops (idle timeout, network blip, etc.) we
// reconnect with exponential backoff (1s → 2s → 4s … 30s cap). A 25 s ping
// keeps the connection alive through Cloudflare / nginx idle timeouts.
// The backend re-surfaces pending permissions on every fresh attach(), so
// approve/deny buttons stay functional after a reconnect.

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

const PING_INTERVAL_MS = 25_000
const RECONNECT_INITIAL_MS = 1_000
const RECONNECT_MAX_MS = 30_000

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
    const sid: string = sessionId  // narrow type for use inside connect() closure
    // Reset live state once per session (not per reconnect).
    setLive([]); flushStreaming(); setThinking(false); setBusy(false); setLastCostUsd(undefined); setError(undefined)

    let stopped = false
    let reconnectDelay = RECONNECT_INITIAL_MS
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let pingTimer: ReturnType<typeof setInterval> | null = null

    function clearTimers() {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null }
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
    }

    function connect() {
      if (stopped) return
      const ws = new WebSocket(`${wsBase()}/api/code-deck/agent-ws?sessionId=${encodeURIComponent(sid)}`)
      wsRef.current = ws

      ws.onopen = () => {
        if (stopped) { ws.close(); return }
        setConnected(true)
        reconnectDelay = RECONNECT_INITIAL_MS // reset backoff on success
        flushStreaming() // discard any partial stream from before disconnect
        // Keep connection alive through Cloudflare / nginx idle timeouts.
        pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'ping' }))
        }, PING_INTERVAL_MS)
      }

      ws.onclose = () => {
        if (stopped) return
        setConnected(false)
        clearTimers()
        // Reconnect with exponential backoff.
        reconnectTimer = setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS)
          connect()
        }, reconnectDelay)
      }

      ws.onerror = () => {
        // onclose always fires after onerror — let it handle reconnect.
        if (!stopped) setConnected(false)
      }

      ws.onmessage = (event) => {
        let m: ServerEvent
        try { m = JSON.parse(String(event.data)) as ServerEvent } catch { return }
        switch (m.t) {
          case 'pong':
            break
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
            setLive((prev) => prev.some((i) => i.kind === 'tool_use' && i.toolUseId === m.toolUseId) ? prev : [...prev, { kind: 'tool_use', key: m.id ?? crypto.randomUUID(), toolUseId: m.toolUseId, name: m.name ?? 'tool', input: m.input }])
            break
          case 'tool_result':
            setLive((prev) => prev.map((i) => i.kind === 'tool_use' && i.toolUseId && i.toolUseId === m.toolUseId ? { ...i, result: m.summary, isError: m.isError } : i))
            break
          case 'permission':
            // On reconnect the backend re-broadcasts pending permissions — skip if already present.
            setLive((prev) => prev.some((i) => i.kind === 'permission' && i.requestId === m.requestId) ? prev : [...prev, { kind: 'permission', key: m.requestId ?? crypto.randomUUID(), requestId: m.requestId ?? '', tool: m.tool ?? 'tool', input: m.input, reason: m.reason, canAlways: m.canAlways, status: 'pending' }])
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
    }

    connect()

    return () => {
      stopped = true
      clearTimers()
      wsRef.current?.close()
      wsRef.current = null
      setConnected(false)
    }
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
    setBusy(false)
    setThinking(false)
    ws.send(JSON.stringify({ t: 'interrupt' }))
  }, [])

  const items = useMemo(() => [...historyItems, ...live], [historyItems, live])
  return { items, streaming, thinking, busy, connected, lastCostUsd, error, send, resolvePermission, interrupt }
}
