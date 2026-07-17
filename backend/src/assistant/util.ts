// Shared helpers for the assistant's in-process MCP tools. Tools call the
// backend's own REST API over loopback (which bypasses auth) instead of
// importing route internals, so every action goes through the exact same code
// paths — and shows up in the same logs — as a button press in the UI.

const SELF_BASE = `http://127.0.0.1:${Number(process.env.PORT) || 3001}/api`

export async function selfApi<T = unknown>(
  path: string,
  init?: { method?: string; body?: unknown; timeoutMs?: number },
): Promise<T> {
  const res = await fetch(`${SELF_BASE}${path}`, {
    method: init?.method ?? 'GET',
    headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(init?.timeoutMs ?? 15_000),
  })
  const text = await res.text()
  let data: unknown
  try { data = JSON.parse(text) } catch { data = { raw: text.slice(0, 500) } }
  if (!res.ok) {
    const detail = (data as { detail?: string; error?: string })
    throw new Error(detail?.detail || detail?.error || `${path} -> HTTP ${res.status}`)
  }
  return data as T
}

// MCP tool result envelopes (same shape the quest agent uses).
export const ok = (payload: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
})
export const fail = (err: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ error: (err as Error).message }) }],
  isError: true,
})
