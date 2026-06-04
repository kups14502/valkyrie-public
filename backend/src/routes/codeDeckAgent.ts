import type { Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { randomUUID } from 'node:crypto'
import { query, type Query, type PermissionResult, type PermissionUpdate, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { getSession, saveMessage, setAgentSessionId, setSessionStatus, profileFor } from './codeDeck.js'

// Live, persistent Code Deck sessions backed by the Claude Agent SDK.
//
// Each Code Deck session id maps to one long-lived AgentRunner. The runner holds
// a single streaming `query()` whose input is an async generator we push user
// turns into, so the whole conversation shares one process and keeps full context
// across messages. Permission prompts are surfaced over the WebSocket as real
// approval requests (canUseTool), and the user's decision is routed back to the
// waiting tool call. The SDK session id is persisted so we can `resume` context
// across server restarts.

type OutEvent = Record<string, unknown>

const DISPOSE_GRACE_MS = 10 * 60 * 1000

// Loosely-typed views of SDK content so we don't pull in the full Beta types.
type Block = { type: string; text?: string; thinking?: string; name?: string; id?: string; input?: unknown; tool_use_id?: string; is_error?: boolean; content?: unknown }
type StreamEvent = { type: string; delta?: { type: string; text?: string; thinking?: string } }

function summarizeToolResult(block: Block): string {
  const c = block.content
  if (typeof c === 'string') return c.slice(0, 600)
  if (Array.isArray(c)) return (c as Block[]).map((x) => (x.type === 'text' ? x.text ?? '' : `[${x.type}]`)).join('\n').slice(0, 600)
  return ''
}

class AgentRunner {
  readonly sessionId: string
  private q: Query | null = null
  private inputQueue: SDKUserMessage[] = []
  private inputResolve: (() => void) | null = null
  private closed = false
  private started = false
  private usedResume = false
  private agentSessionId = ''
  private busy = false
  private readonly sockets = new Set<WebSocket>()
  private readonly pending = new Map<string, { resolve: (r: PermissionResult) => void; input: Record<string, unknown>; suggestions: PermissionUpdate[] }>()
  private disposeTimer: NodeJS.Timeout | null = null

  constructor(sessionId: string) {
    this.sessionId = sessionId
  }

  // ---- socket management -------------------------------------------------
  attach(ws: WebSocket) {
    this.sockets.add(ws)
    if (this.disposeTimer) { clearTimeout(this.disposeTimer); this.disposeTimer = null }
    this.send(ws, { t: 'ready', agentSessionId: this.agentSessionId, busy: this.busy })
    // Re-surface any permission requests still waiting on a human.
    for (const [requestId, p] of this.pending) {
      this.send(ws, { t: 'permission', requestId, tool: String((p.input as { __tool?: string }).__tool ?? ''), input: p.input, canAlways: p.suggestions.length > 0, reason: '' })
    }
  }

  detach(ws: WebSocket) {
    this.sockets.delete(ws)
    if (this.sockets.size === 0) this.scheduleDispose()
  }

  private send(ws: WebSocket, ev: OutEvent) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(ev))
  }

  private broadcast(ev: OutEvent) {
    const s = JSON.stringify(ev)
    for (const ws of this.sockets) if (ws.readyState === ws.OPEN) ws.send(s)
  }

  // ---- input stream ------------------------------------------------------
  private async *inputStream(): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      if (this.inputQueue.length) { yield this.inputQueue.shift()!; continue }
      await new Promise<void>((res) => { this.inputResolve = res })
    }
  }

  submitUser(text: string) {
    const trimmed = text.trim()
    if (!trimmed) return
    const saved = saveMessage(this.sessionId, 'user', trimmed)
    this.broadcast({ t: 'user', id: saved.id, text: trimmed, at: saved.createdAt })
    this.inputQueue.push({ type: 'user', message: { role: 'user', content: trimmed }, parent_tool_use_id: null })
    this.inputResolve?.()
    this.inputResolve = null
    this.start()
  }

  // ---- lifecycle ---------------------------------------------------------
  start() {
    if (this.started || this.closed) return
    const row = getSession(this.sessionId)
    if (!row) { this.broadcast({ t: 'error', message: 'session not found' }); return }
    const profile = profileFor(row.profileId)
    if (profile.provider !== 'claude') { this.broadcast({ t: 'error', message: 'live chat supports Claude profiles only — use terminal mode for codex' }); return }
    this.started = true
    this.agentSessionId = row.agentSessionId || ''
    this.usedResume = Boolean(this.agentSessionId)
    setSessionStatus(this.sessionId, 'running')
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v
    Object.assign(env, profile.env)
    this.q = query({
      prompt: this.inputStream(),
      options: {
        cwd: row.cwd,
        model: row.model,
        permissionMode: 'default',
        includePartialMessages: true,
        env,
        ...(this.agentSessionId ? { resume: this.agentSessionId } : {}),
        canUseTool: (name, input, opts) => this.handlePermission(name, input as Record<string, unknown>, opts),
        stderr: () => { /* swallow CLI noise */ },
      },
    })
    void this.consume()
  }

  private restart() {
    this.q = null
    this.started = false
    this.start()
  }

  private async consume() {
    try {
      for await (const msg of this.q!) this.handleMessage(msg)
    } catch (err) {
      const m = (err as Error)?.message || String(err)
      // A stale resume id (pruned session file) fails the whole query — retry fresh once.
      if (this.usedResume && /resume|session|not found|no conversation|enoent/i.test(m)) {
        this.usedResume = false
        this.agentSessionId = ''
        setAgentSessionId(this.sessionId, '')
        this.restart()
        return
      }
      this.broadcast({ t: 'error', message: m })
    }
    this.busy = false
    this.broadcast({ t: 'busy', value: false })
  }

  private handleMessage(msg: SDKMessage) {
    switch (msg.type) {
      case 'system': {
        if (msg.subtype === 'init') {
          const sid = msg.session_id
          if (sid && sid !== this.agentSessionId) {
            this.agentSessionId = sid
            setAgentSessionId(this.sessionId, sid)
          }
          this.broadcast({ t: 'ready', agentSessionId: this.agentSessionId, model: (msg as { model?: string }).model })
        }
        break
      }
      case 'stream_event': {
        const ev = (msg as { event: StreamEvent }).event
        if (ev.type === 'message_start') { this.busy = true; this.broadcast({ t: 'busy', value: true }) }
        else if (ev.type === 'content_block_delta' && ev.delta) {
          if (ev.delta.type === 'text_delta' && ev.delta.text) this.broadcast({ t: 'delta', text: ev.delta.text })
          else if (ev.delta.type === 'thinking_delta' && ev.delta.thinking) this.broadcast({ t: 'thinking', text: ev.delta.thinking })
        }
        break
      }
      case 'assistant': {
        const blocks = ((msg as { message: { content: Block[] } }).message.content) ?? []
        const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
        if (text.trim()) {
          const saved = saveMessage(this.sessionId, 'assistant', text)
          this.broadcast({ t: 'assistant', id: saved.id, text, at: saved.createdAt })
        }
        for (const b of blocks) {
          if (b.type === 'tool_use') {
            const saved = saveMessage(this.sessionId, 'system', `🔧 ${b.name ?? 'tool'}`, { kind: 'tool_use', toolUseId: b.id, name: b.name, input: b.input })
            this.broadcast({ t: 'tool_use', id: saved.id, toolUseId: b.id, name: b.name, input: b.input, at: saved.createdAt })
          }
        }
        break
      }
      case 'user': {
        const content = (msg as { message: { content: unknown } }).message.content
        if (Array.isArray(content)) {
          for (const b of content as Block[]) {
            if (b.type === 'tool_result') {
              this.broadcast({ t: 'tool_result', toolUseId: b.tool_use_id, isError: Boolean(b.is_error), summary: summarizeToolResult(b) })
            }
          }
        }
        break
      }
      case 'result': {
        this.busy = false
        const r = msg as { subtype?: string; total_cost_usd?: number; duration_ms?: number }
        this.broadcast({ t: 'result', subtype: r.subtype, costUsd: r.total_cost_usd, durationMs: r.duration_ms })
        this.broadcast({ t: 'busy', value: false })
        break
      }
      default:
        break
    }
  }

  // ---- permissions -------------------------------------------------------
  private handlePermission(name: string, input: Record<string, unknown>, opts: { signal: AbortSignal; suggestions?: PermissionUpdate[]; blockedPath?: string; decisionReason?: string }): Promise<PermissionResult> {
    const requestId = randomUUID()
    const suggestions = opts.suggestions ?? []
    const saved = saveMessage(this.sessionId, 'system', `⛔ permission requested: ${name}`, { kind: 'permission', toolName: name, input, reason: opts.decisionReason ?? '' })
    this.broadcast({ t: 'permission', requestId, messageId: saved.id, tool: name, input, reason: opts.decisionReason ?? '', blockedPath: opts.blockedPath ?? '', canAlways: suggestions.length > 0 })
    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(requestId, { resolve, input, suggestions })
      const onAbort = () => {
        if (this.pending.delete(requestId)) {
          resolve({ behavior: 'deny', message: 'aborted' })
          this.broadcast({ t: 'permission_resolved', requestId, decision: 'deny', reason: 'aborted' })
        }
      }
      opts.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  resolvePermission(requestId: string, decision: 'allow' | 'deny', always = false) {
    const entry = this.pending.get(requestId)
    if (!entry) return
    this.pending.delete(requestId)
    if (decision === 'allow') {
      entry.resolve({ behavior: 'allow', updatedInput: entry.input, ...(always && entry.suggestions.length ? { updatedPermissions: entry.suggestions } : {}) })
    } else {
      entry.resolve({ behavior: 'deny', message: 'Denied by operator' })
    }
    this.broadcast({ t: 'permission_resolved', requestId, decision, always })
  }

  async interrupt() {
    try { await this.q?.interrupt() } catch { /* not streaming / already idle */ }
    // Deny any outstanding prompts so the run can unwind.
    for (const requestId of [...this.pending.keys()]) this.resolvePermission(requestId, 'deny')
  }

  private scheduleDispose() {
    if (this.disposeTimer) clearTimeout(this.disposeTimer)
    this.disposeTimer = setTimeout(() => this.dispose(), DISPOSE_GRACE_MS)
  }

  private dispose() {
    this.closed = true
    for (const requestId of [...this.pending.keys()]) this.resolvePermission(requestId, 'deny')
    this.inputResolve?.()
    this.inputResolve = null
    void this.q?.interrupt().catch(() => {})
    runners.delete(this.sessionId)
    setSessionStatus(this.sessionId, 'idle')
  }
}

const runners = new Map<string, AgentRunner>()

function getRunner(sessionId: string): AgentRunner {
  let r = runners.get(sessionId)
  if (!r) { r = new AgentRunner(sessionId); runners.set(sessionId, r) }
  return r
}

export function attachCodeDeckAgentWs(server: Server) {
  // noServer + path-scoped upgrade routing so this composes with the terminal
  // WSS on the same server (see attachCodeDeckWs for why).
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '', 'http://localhost')
    if (pathname !== '/api/code-deck/agent-ws') return
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    const sessionId = url.searchParams.get('sessionId') ?? ''
    const row = getSession(sessionId)
    if (!row) { ws.send(JSON.stringify({ t: 'error', message: 'Code Deck session not found' })); ws.close(); return }
    const runner = getRunner(sessionId)
    runner.attach(ws)
    runner.start()
    ws.on('message', (raw) => {
      let msg: { t?: string; text?: string; requestId?: string; decision?: 'allow' | 'deny'; always?: boolean }
      try { msg = JSON.parse(String(raw)) } catch { return }
      if (msg.t === 'user' && typeof msg.text === 'string') runner.submitUser(msg.text)
      else if (msg.t === 'permission' && msg.requestId && (msg.decision === 'allow' || msg.decision === 'deny')) runner.resolvePermission(msg.requestId, msg.decision, Boolean(msg.always))
      else if (msg.t === 'interrupt') void runner.interrupt()
    })
    ws.on('close', () => runner.detach(ws))
    ws.on('error', () => runner.detach(ws))
  })
}
