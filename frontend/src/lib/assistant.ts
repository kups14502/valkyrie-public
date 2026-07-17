import { getToken } from './auth'

// Client for the general assistant (backend/src/assistant): SSE chat stream,
// speech-to-text, text-to-speech, and voice-health config. Mirrors the fetch
// conventions of GigChat's inline client.

const API_BASE = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api'

const authHeaders = (): Record<string, string> => {
  const token = getToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export type AssistantEvent =
  | { type: 'text'; text: string }
  | { type: 'action'; name: string }
  | { type: 'card'; kind: string; data: unknown }
  | { type: 'done'; sessionId: string | null; isError?: boolean }
  | { type: 'error'; message?: string }

export type AssistantConfig = { name: string; model: string; voice: string; stt: boolean; tts: boolean }

export async function fetchAssistantConfig(): Promise<AssistantConfig> {
  const r = await fetch(`${API_BASE}/assistant/config`, { credentials: 'include', headers: authHeaders() })
  if (!r.ok) throw new Error(`assistant config unavailable (${r.status})`)
  return r.json() as Promise<AssistantConfig>
}

// POST the chat message and feed parsed SSE events to onEvent until the
// stream closes. Returns when the turn is over. AbortSignal cancels the turn.
export async function streamAssistant(
  body: { message: string; sessionId?: string | null },
  onEvent: (ev: AssistantEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const resp = await fetch(`${API_BASE}/assistant/chat`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
    signal,
  })
  if (!resp.ok || !resp.body) throw new Error(`assistant unavailable (${resp.status})`)

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
      try { onEvent(JSON.parse(frame.slice(6)) as AssistantEvent) } catch { /* skip bad frame */ }
    }
  }
}

export async function transcribe(audio: Blob, signal?: AbortSignal): Promise<string> {
  const r = await fetch(`${API_BASE}/assistant/stt`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': audio.type || 'application/octet-stream', ...authHeaders() },
    body: audio,
    signal,
  })
  if (!r.ok) throw new Error(`transcription failed (${r.status})`)
  const { text } = await r.json() as { text?: string }
  return (text ?? '').trim()
}

export async function synthesize(text: string, signal?: AbortSignal): Promise<Blob> {
  const r = await fetch(`${API_BASE}/assistant/tts`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ text }),
    signal,
  })
  if (!r.ok) throw new Error(`speech failed (${r.status})`)
  return r.blob()
}
