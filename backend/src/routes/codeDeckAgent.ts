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

// One-line description of a tool call for the logs (the most useful field per tool).
function toolSummary(name: string | undefined, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  const pick = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '')
  const main = pick('command') || pick('file_path') || pick('path') || pick('pattern') || pick('url') || pick('description') || ''
  const s = main || JSON.stringify(i)
  return `${name ?? 'tool'}(${s.replace(/\s+/g, ' ').slice(0, 120)})`
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
  // The model/account the live stream was actually started with. The stream is a
  // single long-lived query(), so these are locked until we tear it down and
  // restart — see applyConfigChange().
  private activeModel = ''
  private activeProfileId = ''
  private busy = false
  private readonly sockets = new Set<WebSocket>()
  private readonly pending = new Map<string, { resolve: (r: PermissionResult) => void; input: Record<string, unknown>; suggestions: PermissionUpdate[] }>()
  private disposeTimer: NodeJS.Timeout | null = null
  private lastSubmit: { text: string; at: number } | null = null
  private runSeq = 0
  private stderrBuf = ''
  private sawResult = false
  private runStartedAt = 0
  private toolCount = 0
  private readonly toolTimers = new Map<string, { name: string; at: number }>()

  constructor(sessionId: string) {
    this.sessionId = sessionId
  }

  private log(...args: unknown[]) {
    console.log(`[codeDeck ${this.sessionId.slice(0, 8)}]`, ...args)
  }

  // Persist + broadcast an error so it shows as a permanent chat item (not a
  // transient banner) — the user asked for honest "something went wrong" chats.
  private pushError(message: string) {
    let saved
    try { saved = saveMessage(this.sessionId, 'system', `⚠️ ${message}`, { kind: 'error' }) } catch { /* best effort */ }
    this.broadcast({ t: 'error', id: saved?.id, message })
  }

  // ---- socket management -------------------------------------------------
  attach(ws: WebSocket) {
    this.sockets.add(ws)
    this.log('socket attached', `(${this.sockets.size} open, busy=${this.busy})`)
    if (this.disposeTimer) { clearTimeout(this.disposeTimer); this.disposeTimer = null }
    this.send(ws, { t: 'ready', agentSessionId: this.agentSessionId, busy: this.busy })
    // Re-surface any permission requests still waiting on a human.
    for (const [requestId, p] of this.pending) {
      this.send(ws, { t: 'permission', requestId, tool: String((p.input as { __tool?: string }).__tool ?? ''), input: p.input, canAlways: p.suggestions.length > 0, reason: '' })
    }
  }

  detach(ws: WebSocket) {
    this.sockets.delete(ws)
    this.log('socket detached', `(${this.sockets.size} open)`)
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

  submitUser(text: string, attachments: string[] = []) {
    const trimmed = text.trim()
    const paths = attachments.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim())
    if (!trimmed && paths.length === 0) return
    // Attachment paths are part of the message: visible in the chat AND read by
    // the agent. One source of truth so the user can see what was sent.
    const content = paths.length
      ? `${trimmed}${trimmed ? '\n\n' : ''}📎 Attached files (read them from these paths):\n${paths.map((p) => `- ${p}`).join('\n')}`
      : trimmed
    const nowMs = Date.now()
    if (this.lastSubmit && this.lastSubmit.text === content && nowMs - this.lastSubmit.at < 1500) return
    this.lastSubmit = { text: content, at: nowMs }
    this.log('user turn', `${trimmed.slice(0, 80).replace(/\s+/g, ' ')}${paths.length ? ` (+${paths.length} attachment)` : ''}`)
    const saved = saveMessage(this.sessionId, 'user', content)
    this.broadcast({ t: 'user', id: saved.id, text: content, at: saved.createdAt })
    this.inputQueue.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null })
    // If the operator switched model/account since this stream started, restart it
    // so this turn actually runs on the selected model. Don't wake the old input
    // generator (no inputResolve here) — the fresh stream picks up the queued turn.
    const row = getSession(this.sessionId)
    if (this.started && this.q && row && (row.model !== this.activeModel || row.profileId !== this.activeProfileId)) {
      this.log('config change', `${this.activeModel}/${this.activeProfileId} → ${row.model}/${row.profileId} — restarting stream`)
      void this.applyConfigChange()
      return
    }
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
    this.sawResult = false
    this.stderrBuf = ''
    this.runStartedAt = Date.now()
    this.toolCount = 0
    this.toolTimers.clear()
    this.agentSessionId = row.agentSessionId || ''
    this.usedResume = Boolean(this.agentSessionId)
    this.activeModel = row.model
    this.activeProfileId = row.profileId
    setSessionStatus(this.sessionId, 'running')
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v
    Object.assign(env, profile.env)
    const runSeq = ++this.runSeq
    this.log('start run', runSeq, 'model', row.model, this.usedResume ? '(resume)' : '(fresh)')
    this.q = query({
      prompt: this.inputStream(),
      options: {
        cwd: row.cwd,
        model: row.model,
        permissionMode: 'bypassPermissions',
        includePartialMessages: true,
        env,
        ...(this.agentSessionId ? { resume: this.agentSessionId } : {}),
        stderr: (data: string) => {
          // Keep a rolling tail so we can show the real reason a run died.
          this.stderrBuf = (this.stderrBuf + data).slice(-4000)
          const trimmed = data.trim()
          if (trimmed) this.log('cli stderr:', trimmed.slice(0, 400))
        },
      },
    })
    void this.consume(runSeq)
  }

  private restart() {
    this.q = null
    this.started = false
    this.start()
  }

  // The live query() is a single long-lived stream, so the model/account chosen
  // at start() is locked for the session's whole lifetime. When the operator
  // switches model (or account) in the UI mid-session, we must tear the stream
  // down and start a fresh one. `resume` carries the conversation context across,
  // so only the model changes — the history is preserved. The already-queued user
  // turn is picked up by the new stream's input generator.
  private async applyConfigChange() {
    const old = this.q
    this.runSeq++          // make the in-flight consume() loop exit quietly
    this.q = null
    this.started = false
    this.busy = false
    this.broadcast({ t: 'busy', value: false })
    try { await old?.interrupt() } catch { /* already idle / not streaming */ }
    if (this.closed) return
    this.start()           // re-reads model/profile from the row; resumes context
  }

  private async consume(runSeq: number) {
    try {
      for await (const msg of this.q!) {
        if (runSeq !== this.runSeq) return
        // A single bad message (e.g. a transient DB write) must not end the run.
        try { this.handleMessage(msg) } catch (e) { this.log('handleMessage error', (e as Error)?.message) }
      }
    } catch (err) {
      if (runSeq !== this.runSeq) return
      const m = (err as Error)?.message || String(err)
      // A stale resume id (pruned session file) fails the whole query — retry fresh once.
      if (this.usedResume && /resume|session|not found|no conversation|enoent/i.test(m)) {
        this.log('resume failed, retrying fresh:', m)
        this.usedResume = false
        this.agentSessionId = ''
        setAgentSessionId(this.sessionId, '')
        this.restart()
        return
      }
      this.log('run error', m)
      const tail = this.stderrBuf.trim().split('\n').slice(-3).join(' ').slice(-300)
      this.pushError(`Run error: ${m}${tail ? ` — ${tail}` : ''}`)
    }
    if (runSeq === this.runSeq) {
      // If the iterator ended while we were mid-turn (no result seen), the CLI
      // subprocess exited early — tell the user the honest truth instead of
      // silently going idle.
      if (this.busy && !this.sawResult) {
        const tail = this.stderrBuf.trim().split('\n').slice(-3).join(' ').slice(-300)
        this.log('run ended before completion')
        this.pushError(`Agent stopped before finishing${tail ? ` — ${tail}` : ' (process exited). Send another message to continue.'}`)
      } else {
        this.log('run complete', runSeq)
      }
      this.busy = false
      this.started = false
      this.q = null
      this.broadcast({ t: 'busy', value: false })
    }
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
        // Stay busy for the whole turn. message_stop fires between every tool
        // step, so toggling busy off here made the status flash; busy only
        // clears on `result`, interrupt, or the run loop ending.
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
            this.busy = true
            this.broadcast({ t: 'busy', value: true })
            this.toolCount++
            if (b.id) this.toolTimers.set(b.id, { name: b.name ?? 'tool', at: Date.now() })
            this.log('tool →', toolSummary(b.name, b.input))
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
              const summary = summarizeToolResult(b)
              const timer = b.tool_use_id ? this.toolTimers.get(b.tool_use_id) : undefined
              if (b.tool_use_id) this.toolTimers.delete(b.tool_use_id)
              const ms = timer ? Date.now() - timer.at : null
              this.log('tool ✓', `${timer?.name ?? 'tool'}${b.is_error ? ' ERROR' : ''}${ms != null ? ` ${ms}ms` : ''}`)
              saveMessage(this.sessionId, 'system', `↳ tool result: ${b.tool_use_id ?? ''}`, { kind: 'tool_result', toolUseId: b.tool_use_id, isError: Boolean(b.is_error), summary })
              this.broadcast({ t: 'tool_result', toolUseId: b.tool_use_id, isError: Boolean(b.is_error), summary })
            }
          }
        }
        break
      }
      case 'result': {
        this.sawResult = true
        this.busy = false
        const r = msg as { subtype?: string; total_cost_usd?: number; duration_ms?: number; is_error?: boolean }
        const wall = Date.now() - this.runStartedAt
        this.log('run summary', `subtype=${r.subtype ?? '?'} tools=${this.toolCount} cost=$${(r.total_cost_usd ?? 0).toFixed(4)} wall=${wall}ms`)
        // The SDK reports turn-level failures (max turns, model error, etc.) via
        // result.subtype — surface those as honest error chats too.
        if (r.is_error || (r.subtype && r.subtype !== 'success')) {
          this.pushError(`Run ended: ${r.subtype ?? 'error'}`)
        }
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
    this.log('interrupt by operator')
    const old = this.q
    this.runSeq++
    this.q = null
    this.started = false
    this.inputQueue = []
    // Deny any outstanding prompts so the run can unwind.
    for (const requestId of [...this.pending.keys()]) this.resolvePermission(requestId, 'deny')
    this.busy = false
    saveMessage(this.sessionId, 'system', 'Stopped by operator.')
    setSessionStatus(this.sessionId, 'idle')
    this.broadcast({ t: 'busy', value: false })
    try { await old?.interrupt() } catch { /* not streaming / already idle */ }
  }

  private scheduleDispose() {
    if (this.disposeTimer) clearTimeout(this.disposeTimer)
    this.disposeTimer = setTimeout(() => this.dispose(), DISPOSE_GRACE_MS)
  }

  private dispose() {
    this.log('dispose (idle, no sockets)')
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
      let msg: { t?: string; text?: string; attachments?: unknown; requestId?: string; decision?: 'allow' | 'deny'; always?: boolean }
      try { msg = JSON.parse(String(raw)) } catch { return }
      if (msg.t === 'ping') { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'pong' })) }
      else if (msg.t === 'user' && typeof msg.text === 'string') runner.submitUser(msg.text, Array.isArray(msg.attachments) ? msg.attachments.filter((p): p is string => typeof p === 'string') : [])
      else if (msg.t === 'permission' && msg.requestId && (msg.decision === 'allow' || msg.decision === 'deny')) runner.resolvePermission(msg.requestId, msg.decision, Boolean(msg.always))
      else if (msg.t === 'interrupt') void runner.interrupt()
    })
    ws.on('close', () => runner.detach(ws))
    ws.on('error', () => runner.detach(ws))
  })
}
