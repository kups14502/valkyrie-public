import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { MessageSquare, Send, X } from 'lucide-react'
import { getToken } from '../lib/auth'

// Quest agent chat: a floating terminal-styled panel on the quest log that
// drives the backend quest agent (SSE). The agent's tools are server-side
// wrappers around the quest store, so anything it does shows up in the log
// immediately (we invalidate the quests query after every turn).

const API_BASE = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api'

type ChatMsg = { role: 'user' | 'agent'; text: string; actions?: string[] }

const ACTION_LABEL: Record<string, string> = {
  list_quests: 'reading quest log',
  create_quest: 'accepting quest',
  update_quest: 'updating quest',
  add_objectives: 'adding objectives',
  delete_quest: 'deleting quest',
  add_link: 'linking',
}

export function QuestChat({ openQuest }: { openQuest: { id: string; title: string } | null }) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const sessionRef = useRef<string | null>(sessionStorage.getItem('valkyrie-quest-agent-session'))
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, open])
  useEffect(() => { if (open) inputRef.current?.focus() }, [open])

  const sendMessage = async () => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    setBusy(true)
    setMessages((m) => [...m, { role: 'user', text }, { role: 'agent', text: '' }])

    const append = (fn: (last: ChatMsg) => ChatMsg) =>
      setMessages((m) => m.map((msg, i) => (i === m.length - 1 ? fn(msg) : msg)))

    try {
      const token = getToken()
      const resp = await fetch(`${API_BASE}/quests/chat`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ message: text, sessionId: sessionRef.current, openQuest }),
      })
      if (!resp.ok || !resp.body) throw new Error(`agent unavailable (${resp.status})`)

      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          if (!frame.startsWith('data: ')) continue
          let ev: { type: string; text?: string; name?: string; sessionId?: string | null; message?: string }
          try { ev = JSON.parse(frame.slice(6)) } catch { continue }
          if (ev.type === 'text' && ev.text) {
            append((last) => ({ ...last, text: last.text ? `${last.text}\n${ev.text}` : ev.text! }))
          } else if (ev.type === 'action' && ev.name) {
            const label = ACTION_LABEL[ev.name] ?? ev.name
            append((last) => ({ ...last, actions: [...(last.actions ?? []), label] }))
            if (ev.name !== 'list_quests') void queryClient.invalidateQueries({ queryKey: ['quests'] })
          } else if (ev.type === 'done') {
            if (ev.sessionId) {
              sessionRef.current = ev.sessionId
              sessionStorage.setItem('valkyrie-quest-agent-session', ev.sessionId)
            }
          } else if (ev.type === 'error') {
            append((last) => ({ ...last, text: last.text || `! ${ev.message ?? 'agent failed'}` }))
          }
        }
      }
    } catch (err) {
      append((last) => ({ ...last, text: last.text || `! ${(err as Error).message}` }))
    } finally {
      setBusy(false)
      void queryClient.invalidateQueries({ queryKey: ['quests'] })
      inputRef.current?.focus()
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Quest agent: add, complete, and modify quests in plain language"
        className="fixed bottom-5 right-5 z-40 flex items-center gap-2 border border-[var(--color-accent)]/60 bg-[var(--color-bg)] px-3.5 py-2.5 text-xs uppercase tracking-[0.16em] text-[var(--color-accent)] transition hover:bg-[rgba(var(--color-accent-rgb),0.08)]"
        style={{ boxShadow: '0 0 12px rgba(var(--color-accent-rgb),0.25)' }}
      >
        <MessageSquare size={15} /> agent
      </button>
    )
  }

  return (
    <div
      className="fixed bottom-5 right-5 z-40 flex w-[min(420px,calc(100vw-40px))] flex-col border border-[var(--color-border-strong)] bg-[var(--color-bg)]"
      style={{ height: 'min(560px, calc(100vh - 120px))', boxShadow: '0 0 24px rgba(0,0,0,0.6), 0 0 12px rgba(var(--color-accent-rgb),0.15)' }}
    >
      <div className="shrink-0 border-b border-[var(--color-border)] px-3.5 py-2.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-[0.28em] text-[var(--color-accent)]" style={{ textShadow: '0 0 8px var(--color-accent)' }}>
            // quest agent
          </span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close agent"
            className="p-1 text-[var(--color-text-faint)] transition hover:text-[var(--color-text)]"
          >
            <X size={15} />
          </button>
        </div>
        {openQuest && (
          <div
            className="mt-1 truncate text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-faint)]"
            title={`"this quest" = ${openQuest.title}`}
          >
            ctx: {openQuest.title}
          </div>
        )}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3.5 py-3">
        {messages.length === 0 && (
          <div className="text-xs leading-relaxed text-[var(--color-text-faint)]">
            &gt; add, complete, and modify quests in plain language.
            <br />&gt; the open quest is the default target: "put this on hold",
            <br />&gt; "add an objective: call marc", "mark it done".
            <br />&gt; or name one: "complete the printer quest"
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i}>
            {m.role === 'user' ? (
              <div className="text-sm text-[var(--color-accent-2)]">
                <span className="text-[var(--color-text-faint)]">&gt; </span>{m.text}
              </div>
            ) : (
              <div className="space-y-1">
                {m.actions?.map((a, j) => (
                  <div key={j} className="text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-faint)]">⟳ {a}</div>
                ))}
                <div className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--color-text)]">
                  {m.text || (busy && i === messages.length - 1 ? <span className="cursor-blink">_</span> : '')}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <form
        className="flex shrink-0 items-center gap-2 border-t border-[var(--color-border)] px-3 py-2.5"
        onSubmit={(e) => { e.preventDefault(); void sendMessage() }}
      >
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={busy ? 'working…' : 'command your quest log…'}
          disabled={busy}
          className="min-w-0 flex-1 border border-[var(--color-border)] bg-transparent px-2.5 py-2 text-sm text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-border-strong)] disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          aria-label="Send"
          className="border border-[var(--color-accent)]/60 p-2 text-[var(--color-accent)] transition hover:bg-[rgba(var(--color-accent-rgb),0.08)] disabled:opacity-40"
        >
          <Send size={15} />
        </button>
      </form>
    </div>
  )
}
