import { useEffect, useRef, useState } from 'react'
import { fetchTermTranscript, type TranscriptEntry, type TranscriptPage, type TranscriptTodo } from '../../../lib/api'
import { errText } from '../../../lib/term'
import { userPart } from './user'

// The Chat view's data: the pane's transcript, read from the server about once
// a second while the page is visible (GET /terminal/sessions/:name/transcript,
// lib/api.ts). The entries stay in memory, and the newest of them in a small
// localStorage cache per pane, so a reload or a return to the page paints the
// conversation at once and the first read only brings it up to date.

/** How often the transcript is read while the page is on screen, and while it is not. */
const VISIBLE_MS = 1000
const HIDDEN_MS = 20_000
/** A server with no transcript route (an older API) is asked again this rarely. */
const MISSING_MS = 30_000
/** The longest wait between retries after errors. */
const BACKOFF_MAX_MS = 15_000
/** What the page keeps in memory: a long session is thousands of entries. */
const MAX_ENTRIES = 1500

export type TranscriptStatus = 'loading' | 'ok' | 'missing' | 'error'

export type Transcript = {
  entries: TranscriptEntry[]
  sessionId: string | null
  status: TranscriptStatus
  error: string | null
  /** Bumped when the server says the pane moved to another transcript (or on the first read). */
  gen: number
  /** The entries on screen came from the cache and have not been read fresh yet. */
  cached: boolean
}

const EMPTY: Transcript = { entries: [], sessionId: null, status: 'loading', error: null, gen: 0, cached: false }

// ---------- the cache ----------

const CACHE_PREFIX = 'v2.chat.'
const CACHE_INDEX = 'v2.chat.index'
const CACHE_PANES = 5
const CACHE_ENTRIES = 50
const CACHE_TEXT = 6000
const CACHE_RESULT = 1500
const CACHE_INPUT = 2500

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s)

/** An input with every long string cut, so one big Write cannot fill the cache. */
function slimInput(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return cut(v, CACHE_INPUT)
  if (!v || typeof v !== 'object' || depth > 4) return v
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => slimInput(x, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v)) out[k] = slimInput(x, depth + 1)
  return out
}

function slim(e: TranscriptEntry): TranscriptEntry {
  const s: TranscriptEntry = { ...e }
  if (s.text) s.text = cut(s.text, CACHE_TEXT)
  if (s.tool) s.tool = { ...s.tool, input: slimInput(s.tool.input) }
  if (s.result && s.result.text.length > CACHE_RESULT) s.result = { ...s.result, text: s.result.text.slice(0, CACHE_RESULT), truncated: true }
  return s
}

type Cached = { v: 1; sessionId: string | null; entries: TranscriptEntry[] }

function readCache(name: string): Transcript | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + name)
    if (!raw) return null
    const c = JSON.parse(raw) as Cached
    if (c?.v !== 1 || !Array.isArray(c.entries)) return null
    return { ...EMPTY, entries: c.entries, sessionId: c.sessionId ?? null, cached: true }
  } catch {
    return null
  }
}

function writeCache(name: string, t: Transcript): void {
  const body: Cached = { v: 1, sessionId: t.sessionId, entries: t.entries.slice(-CACHE_ENTRIES).map(slim) }
  const put = () => {
    let idx: string[]
    try { idx = JSON.parse(localStorage.getItem(CACHE_INDEX) || '[]') as string[] } catch { idx = [] }
    if (!Array.isArray(idx)) idx = []
    idx = [name, ...idx.filter((n) => n !== name)]
    for (const old of idx.slice(CACHE_PANES)) localStorage.removeItem(CACHE_PREFIX + old)
    idx = idx.slice(0, CACHE_PANES)
    localStorage.setItem(CACHE_INDEX, JSON.stringify(idx))
    localStorage.setItem(CACHE_PREFIX + name, JSON.stringify(body))
  }
  try {
    put()
  } catch {
    // full: drop every other pane's cache and try once more
    try {
      const idx = JSON.parse(localStorage.getItem(CACHE_INDEX) || '[]') as string[]
      for (const n of Array.isArray(idx) ? idx : []) if (n !== name) localStorage.removeItem(CACHE_PREFIX + n)
      localStorage.setItem(CACHE_INDEX, JSON.stringify([name]))
      localStorage.setItem(CACHE_PREFIX + name, JSON.stringify(body))
    } catch { /* storage unavailable */ }
  }
}

// ---------- merging a page ----------

/** A page of entries laid onto what the page already has. */
export function applyPage(cur: Transcript, page: TranscriptPage, first: boolean): Transcript {
  const replace = first || page.reset
  // nothing new: the same object, so a quiet second costs no render (also a
  // pane with no transcript yet, which answers an empty first read each time)
  const same = !page.entries.length && cur.status === 'ok' && !cur.cached && cur.sessionId === page.sessionId
  if (same && (!replace || !cur.entries.length)) return cur
  let entries: TranscriptEntry[]
  if (replace) {
    const seen = new Set<string>()
    entries = page.entries.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
  } else if (page.entries.length) {
    const at = new Map(cur.entries.map((e, i) => [e.id, i]))
    entries = cur.entries.slice()
    for (const e of page.entries) {
      const i = at.get(e.id)
      if (i === undefined) {
        at.set(e.id, entries.length)
        entries.push(e)
      } else entries[i] = e
    }
  } else entries = cur.entries
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES)
  return {
    entries,
    sessionId: page.sessionId,
    status: 'ok',
    error: null,
    gen: replace ? cur.gen + 1 : cur.gen,
    cached: false,
  }
}

/**
 * The pane's transcript, kept current while `on`. Off (the Terminal view, a
 * shell pane, a session that ended) it stops reading and keeps what it has.
 */
export function useTranscript(name: string, on: boolean): Transcript {
  const [state, setState] = useState<Transcript>(() => readCache(name) ?? EMPTY)
  const stateRef = useRef(state)
  useEffect(() => { stateRef.current = state }, [state])

  useEffect(() => {
    if (!on) return
    let alive = true
    let timer = 0
    let ctrl: AbortController | null = null
    // null: the next read is a first read (the newest entries, replacing the cache)
    let cursor: string | null = null
    let fails = 0
    let busy = false

    const schedule = (ms: number) => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => { void tick() }, ms)
    }
    const tick = async () => {
      if (!alive || busy) return
      busy = true
      ctrl = new AbortController()
      try {
        const page = await fetchTermTranscript(name, cursor, ctrl.signal)
        if (!alive) return
        const first = cursor === null
        // no cursor back: the pane has no transcript (yet), so the next read starts over
        cursor = page.cursor || null
        fails = 0
        setState((cur) => applyPage(cur, page, first))
        schedule(page.more ? 0 : document.visibilityState === 'visible' ? VISIBLE_MS : HIDDEN_MS)
      } catch (e) {
        if (!alive || ctrl?.signal.aborted) return
        const status = (e as { response?: { status?: number } } | null)?.response?.status
        fails += 1
        setState((cur) => ({ ...cur, status: status === 404 && !cur.entries.length ? 'missing' : 'error', error: errText(e) }))
        schedule(status === 404 ? MISSING_MS : Math.min(BACKOFF_MAX_MS, 1000 * 2 ** Math.min(fails, 4)))
      } finally {
        busy = false
      }
    }
    // back on screen: read now instead of waiting out the hidden interval
    const onVisible = () => {
      if (document.visibilityState === 'visible' && fails === 0) schedule(0)
    }
    document.addEventListener('visibilitychange', onVisible)
    schedule(0)
    return () => {
      alive = false
      window.clearTimeout(timer)
      ctrl?.abort()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [name, on])

  // the cache: at most every few seconds, and when the page goes away
  const savedRef = useRef<TranscriptEntry[] | null>(null)
  const savedAt = useRef(0)
  useEffect(() => {
    if (state.cached || state.status !== 'ok' || savedRef.current === state.entries) return
    const t = window.setTimeout(() => {
      savedRef.current = state.entries
      savedAt.current = Date.now()
      writeCache(name, state)
    }, Math.max(400, 3000 - (Date.now() - savedAt.current)))
    return () => window.clearTimeout(t)
  }, [name, state])
  useEffect(() => {
    const flush = () => {
      const s = stateRef.current
      if (document.visibilityState === 'hidden' && !s.cached && s.status === 'ok' && savedRef.current !== s.entries) {
        savedRef.current = s.entries
        writeCache(name, s)
      }
    }
    document.addEventListener('visibilitychange', flush)
    return () => document.removeEventListener('visibilitychange', flush)
  }, [name])

  return state
}

// ---------- reading the entries ----------

/** The todo list as it stands: the newest todo update, and where it sits. */
export function latestTodos(entries: TranscriptEntry[]): { todos: TranscriptTodo[]; index: number } | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.kind === 'todo' && e.todos) return { todos: e.todos, index: i }
    if (e.kind === 'tool' && e.tool?.name === 'TodoWrite') {
      const t = todosOfInput(e.tool.input)
      if (t) return { todos: t, index: i }
    }
  }
  return null
}

/**
 * The todo list worth showing: one with steps still open, or a finished one
 * until Brendon sends the next prompt.
 */
export function liveTodos(entries: TranscriptEntry[]): TranscriptTodo[] | null {
  const t = latestTodos(entries)
  if (!t || !t.todos.length) return null
  if (t.todos.some((x) => x.status !== 'completed')) return t.todos
  for (let i = entries.length - 1; i > t.index; i--) {
    const e = entries[i]
    if (e.kind === 'user' && userPart(e.text ?? '').kind === 'prompt') return null
  }
  return t.todos
}

export function todosOfInput(input: unknown): TranscriptTodo[] | null {
  const list = (input as { todos?: unknown } | null)?.todos
  if (!Array.isArray(list)) return null
  return list
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((x) => ({ content: typeof x.content === 'string' ? x.content : '', status: typeof x.status === 'string' ? x.status : 'pending' }))
}

/**
 * How full the context is, in percent used: the newest assistant entry's
 * input tokens against its model's window (the server sends both). null
 * before Claude has answered, or from a server that predates usage.
 */
export function latestContext(entries: TranscriptEntry[]): number | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const u = entries[i].usage
    if (u && u.window > 0) return Math.min(100, Math.max(0, Math.round((u.tokens / u.window) * 100)))
  }
  return null
}

/** The model of the newest assistant entry, as a short name ("Opus 5.5"). */
export function latestModel(entries: TranscriptEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const m = entries[i].model
    if (m && !m.startsWith('<')) return modelName(m)
  }
  return null
}

export function modelName(id: string): string {
  const base = id.replace(/\[.*\]$/, '').replace(/^claude-/, '').replace(/-\d{8}$/, '')
  const parts = base.split('-')
  const name = parts.filter((p) => !/^\d+$/.test(p))
  const ver = parts.filter((p) => /^\d+$/.test(p))
  if (!name.length) return id
  const word = name.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ')
  return ver.length ? `${word} ${ver.join('.')}` : word
}
