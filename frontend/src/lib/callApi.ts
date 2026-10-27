import { api } from './api'

// AI > Call: thor's call-assist service through odin (backend routes/callAssist.ts).

/** who: the other side of the call (what thor plays) or Brendon (the mic) */
export type CallLine = { n: number; at: string; who: 'caller' | 'me'; text: string }

export type CallCard = {
  id: string
  at: string
  title: string
  body: string
  /** the question Brendon typed, when the card answers one */
  ask: string | null
  /** what Claude looked up for it ("Docs: <company>", "KB: printer") */
  sources: string[]
  ms: number
}

export type CallLive = {
  id: string
  area: { id: string; label: string }
  startedAt: string
  /** thor's listener: Whisper loading, hearing the call, stopped, or failed */
  hearing: 'starting' | 'on' | 'off' | 'error'
  /** what it hears: the output device (the caller) and the mic, once it hears them */
  devices: { caller: string | null; me: string | null } | null
  brain: 'starting' | 'ready' | 'error'
  /** what Claude is doing right now ("Thinking", "Docs: <company>"), null when idle */
  activity: string | null
  /** the card being written, before it is done */
  draft: string | null
  /** the sentence the caller is still saying */
  partial: string
  lineCount: number
  /** lines after the poll's `after` */
  lines: CallLine[]
  cards: CallCard[]
  queued: number
  error: string | null
}

export type CallLast = { area: string; startedAt: string; endedAt: string; lines: number; cards: number; saved: string | null }

export type CallState = {
  rev: number
  status: 'idle' | 'live' | 'stopping'
  areas: { id: string; label: string }[]
  last: CallLast | null
  call: CallLive | null
}

/** Long poll: answers at once when thor's rev is not `rev`, else on the next change or after `wait` seconds. */
export const fetchCallState = async (rev: number, after: number, wait: number, signal?: AbortSignal) =>
  (await api.get<CallState>('/call/state', { params: { rev, after, wait }, signal, timeout: (wait + 20) * 1000 })).data

export const startCall = async (area: string) => (await api.post<CallState>('/call/start', { area })).data

export const stopCall = async (save: boolean) => (await api.post<{ ok: true; last: CallLast }>('/call/stop', { save })).data

export const askCall = async (text: string) => { await api.post('/call/ask', { text }) }

export const dismissCallCard = async (id: string) => { await api.post('/call/dismiss', { id }) }
