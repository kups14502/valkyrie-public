import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiErrorText, fetchImgToken, imgTrusted } from '../../lib/api'
import {
  RAVEN_FILE_MAX, fetchMsgCount, fetchRaven, patchSettings, ravenFileUrl, saveRavenSettings, transcribeRaven, uploadRavenFile, waitMsgChange,
  type RavenPage, type RavenSettingsPatch,
} from '../../lib/ravenApi'
import { DRAFT_PREFIX, RAVEN_THREAD, createDraftStore, draftIds, type DraftFile, type DraftSnap } from './ravenDraft'
import { toast } from './ui'
import { useLive, type Live } from './data'

// Raven's state for the Raven screen, the Dashboard's Raven block and the quick sheet (kit/raven.tsx):
// the thread and its long-poll, the unread badge, the draft with its
// attachments, the file URLs, and the quick sheet's open switch. No
// components here (the react-refresh lint keeps hooks out of component files).

export const RAVEN_KEY = ['raven'] as const

/**
 * GET /api/raven while `on`, kept current by the Messages long-poll while `live` too. The
 * Dashboard's block holds the long-poll only while a reply is due: it holds one of the
 * browser's few connections to odin for as long as it runs.
 */
export function useRaven(on: boolean, live = true) {
  // the long-poll carries the changes; the slow poll only covers a dropped one
  const q = useQuery({ queryKey: RAVEN_KEY, queryFn: fetchRaven, enabled: on, refetchOnWindowFocus: true, refetchInterval: 60_000, retry: 1 })
  useRavenLive(on && live, q.data?.seq)
  return q
}

/** Re-reads Raven whenever the backend says Messages changed (GET /api/msg/changes, about 25 s per wait). */
function useRavenLive(on: boolean, seq: number | undefined) {
  const qc = useQueryClient()
  const known = seq !== undefined
  useEffect(() => {
    if (!on || seq === undefined) return
    const ac = new AbortController()
    let since = seq
    let stop = false
    void (async () => {
      while (!stop) {
        const t0 = Date.now()
        try {
          const next = await waitMsgChange(since, ac.signal)
          if (stop) return
          if (next !== since) {
            since = next
            await Promise.all([
              qc.invalidateQueries({ queryKey: RAVEN_KEY }),
              qc.invalidateQueries({ queryKey: ['v2', UNREAD_KEY] }),
            ])
          } else if (Date.now() - t0 < 1000) {
            // an answer with no change that came back at once (a proxy, a restart): no tight loop
            await new Promise((r) => setTimeout(r, 3000))
          }
        } catch {
          if (stop) return
          await new Promise((r) => setTimeout(r, 5000))
        }
      }
    })()
    return () => { stop = true; ac.abort() }
    // the loop carries its own count; it restarts only when the screen wakes or first learns one
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, known, qc])
}

const UNREAD_KEY = 'raven-unread'

/** Raven's unread count for the Raven tab's badge (GET /api/msg/count). */
export function useRavenUnread(): Live<{ unread: number }> {
  return useLive(UNREAD_KEY, fetchMsgCount, 30_000)
}

/** Drop the cached badge after a read, so it follows at once. */
export function refreshRavenUnread(qc: ReturnType<typeof useQueryClient>): void {
  void qc.invalidateQueries({ queryKey: ['v2', UNREAD_KEY] })
}

/** Put a message Raven's backend just took into the cached thread, before the next read. */
export function addToThread(qc: ReturnType<typeof useQueryClient>, page: Partial<RavenPage> & { messages?: RavenPage['messages'] }): void {
  qc.setQueryData<RavenPage>(RAVEN_KEY, (cur) => {
    if (!cur) return cur
    const have = new Set(cur.messages.map((m) => m.id))
    const add = (page.messages ?? []).filter((m) => !have.has(m.id))
    return { ...cur, ...page, messages: [...cur.messages, ...add] }
  })
}

// ---------- the model and effort pick ----------

/**
 * Save a change to his pick: shown at once in the cached page, then POST /api/raven/settings. Every other device
 * re-reads it through the long-poll (the backend bumps Messages). A refusal puts the page back and says why.
 */
export function useSaveRavenSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: saveRavenSettings,
    onMutate: (patch: RavenSettingsPatch) => {
      const before = qc.getQueryData<RavenPage>(RAVEN_KEY)
      if (before?.settings) qc.setQueryData<RavenPage>(RAVEN_KEY, { ...before, settings: patchSettings(before.settings, patch) })
      return { before }
    },
    onSuccess: (r) => {
      qc.setQueryData<RavenPage>(RAVEN_KEY, (cur) => (cur ? { ...cur, settings: r.settings, models: r.models } : cur))
    },
    onError: (e, _p, ctx) => {
      if (ctx?.before) qc.setQueryData(RAVEN_KEY, ctx.before)
      toast(apiErrorText(e, 'Raven did not save that'), { ms: 4000 })
    },
  })
}

// ---------- files ----------

/** (id) => the file's URL, carrying the short-lived image token when this client needs one; null until it has it. */
export function useRavenFileUrl(): (id: string) => string | null {
  const need = !imgTrusted()
  const tok = useQuery({
    queryKey: ['plex-img-token'],
    queryFn: fetchImgToken,
    enabled: need,
    staleTime: 5 * 3600_000,
    refetchInterval: 5 * 3600_000,
    retry: 1,
  })
  const token = tok.data?.token ?? null
  return useCallback((id: string) => (need && !token ? null : ravenFileUrl(id, need ? token : null)), [need, token])
}

// ---------- the draft: text and attachments ----------
// The store itself is kit/ravenDraft.ts: one draft per thread, kept in this device's localStorage, shared by every
// composer on the thread, cleared only by a send.

export type { DraftFile, DraftSnap } from './ravenDraft'

const localStore = (): Storage | null => {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

const drafts = createDraftStore({
  storage: localStore(),
  upload: (file, onProgress, signal) => uploadRavenFile(file, (sent) => onProgress(sent), signal),
  maxBytes: RAVEN_FILE_MAX,
  preview: (f) => (f.type.startsWith('image/') && f.size < 40 * 1024 * 1024 ? URL.createObjectURL(f) : undefined),
  revoke: (u) => URL.revokeObjectURL(u),
})

// another window of the app on this device (a pop-out) changed a draft
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === null) drafts.adopt(null, null)
    else if (e.key.startsWith(DRAFT_PREFIX)) drafts.adopt(e.key.slice(DRAFT_PREFIX.length), e.newValue)
  })
}

export type RavenDraft = {
  text: string
  setText: (t: string) => void
  /** words from a recording, joined to the end of the text */
  append: (words: string) => void
  files: DraftFile[]
  add: (list: FileList | File[]) => void
  remove: (key: string) => void
  retry: (key: string) => void
  /** what a send takes now; hand it back to markSent once the send went */
  snapshot: () => DraftSnap
  /** the send went: what it carried leaves the draft, anything added since stays */
  markSent: (snap: DraftSnap) => void
  /** clears the text and the landed files now (a send that kept no snapshot); failed and uploading files stay */
  clear: () => void
  /** a file is still on its way */
  uploading: boolean
  /** there is something to send and nothing still uploading */
  ready: boolean
  /** the ids of the files that landed */
  ids: string[]
}

/** The thread's unsent text and attachments, the same in every composer on it; each file goes up to odin as soon as it is picked. */
export function useRavenDraft(thread: string = RAVEN_THREAD): RavenDraft {
  const s = useSyncExternalStore(drafts.subscribe, () => drafts.get(thread), () => drafts.get(thread))
  const api = useMemo(() => ({
    setText: (t: string) => drafts.setText(thread, t),
    append: (w: string) => drafts.append(thread, w),
    add: (list: FileList | File[]) => drafts.add(thread, list),
    remove: (key: string) => drafts.remove(thread, key),
    retry: (key: string) => drafts.retry(thread, key),
    snapshot: () => drafts.snapshot(thread),
    markSent: (snap: DraftSnap) => drafts.markSent(thread, snap),
    clear: () => drafts.markSent(thread, drafts.snapshot(thread)),
  }), [thread])
  const uploading = s.files.some((f) => f.state === 'up')
  const ids = draftIds(s)
  const ready = !uploading && (s.text.trim() !== '' || ids.length > 0)
  return { ...api, text: s.text, files: s.files, uploading, ready, ids }
}

// ---------- the quick sheet's switch ----------

type QuickState = { open: boolean; at: number }
let quick: QuickState = { open: false, at: 0 }
const quickListeners = new Set<() => void>()
const quickSubscribe = (l: () => void) => {
  quickListeners.add(l)
  return () => { quickListeners.delete(l) }
}
/** set by the mounted sheet: opens it synchronously and focuses its box (iOS raises the keyboard only inside the tap) */
let opener: (() => void) | null = null

export function setQuickOpener(fn: (() => void) | null): void {
  opener = fn
}

export function setQuickOpen(open: boolean): void {
  if (quick.open === open) return
  quick = { open, at: Date.now() }
  quickListeners.forEach((l) => l())
}

/** Open the quick sheet (the floating button, Ctrl+Shift+Space, the palette). Call it inside the tap. */
export function openRavenQuick(): void {
  if (opener) opener()
  else setQuickOpen(true)
}

export function useQuickOpen(): boolean {
  return useSyncExternalStore(quickSubscribe, () => quick.open, () => false)
}

// ---------- the keyboard on a phone ----------

/** How far the on-screen keyboard covers the bottom of the layout viewport (iOS keeps fixed boxes under it). */
export function useKeyboardInset(on: boolean): number {
  const [inset, setInset] = useState(0)
  useEffect(() => {
    const vv = window.visualViewport
    if (!on || !vv) return
    const read = () => {
      const covered = window.innerHeight - vv.height - vv.offsetTop
      setInset(covered > 60 ? Math.round(covered) : 0)
    }
    read()
    vv.addEventListener('resize', read)
    vv.addEventListener('scroll', read)
    return () => {
      vv.removeEventListener('resize', read)
      vv.removeEventListener('scroll', read)
    }
  }, [on])
  return on ? inset : 0
}

// ---------- voice input ----------
// One recorder for the whole app. The mic button in a composer starts and stops it; the push-to-talk key (held)
// does the same from anywhere. The clip goes to odin (POST /api/raven/transcribe, whisper on odin) and the words
// land in a composer's box for him to read and edit: never sent by themselves. Each visible composer registers a
// sink; the words go to the composer whose mic was tapped, else the one in front (the last to register), else
// straight into the thread's draft (kept on the device), where the next composer to open shows them.

export type VoicePhase = 'idle' | 'starting' | 'recording' | 'writing'
export type VoiceState = { phase: VoicePhase; since: number; owner: number | null; ptt: boolean }

let voice: VoiceState = { phase: 'idle', since: 0, owner: null, ptt: false }
const voiceSubs = new Set<() => void>()
const setVoice = (p: Partial<VoiceState>) => {
  voice = { ...voice, ...p }
  for (const f of voiceSubs) f()
}
const voiceSubscribe = (f: () => void) => {
  voiceSubs.add(f)
  return () => { voiceSubs.delete(f) }
}

/** The recorder's state, for the mic buttons and the recording line. */
export function useRavenVoice(): VoiceState {
  return useSyncExternalStore(voiceSubscribe, () => voice, () => voice)
}

type Sink = { id: number; put: (text: string) => void }
const sinks: Sink[] = []
let sinkSeq = 0

/** A composer takes the words while `on` (its screen in front). Answers the id its mic button passes. */
export function useVoiceSink(on: boolean, put: (text: string) => void): number {
  const [id] = useState(() => ++sinkSeq)
  const ref = useRef(put)
  useEffect(() => { ref.current = put })
  useEffect(() => {
    if (!on) return
    const sink: Sink = { id, put: (t) => ref.current(t) }
    sinks.push(sink)
    return () => {
      const i = sinks.indexOf(sink)
      if (i >= 0) sinks.splice(i, 1)
    }
  }, [on, id])
  return id
}

const MAX_CLIP_MS = 3 * 60_000
let rec: { mr: MediaRecorder; stream: MediaStream; chunks: Blob[]; type: string; started: number; timer: number } | null = null
let stopAsked = false

const MIME_TRY = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']

function micError(e: unknown): string {
  const name = (e as { name?: string })?.name ?? ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access is blocked. Allow the microphone for Valkyrie (iPhone and iPad: Settings > Safari > Microphone), then try again.'
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone found on this device.'
  if (name === 'NotReadableError') return 'The microphone is busy in another app.'
  return 'The microphone did not start.'
}

function deliver(text: string, owner: number | null): void {
  const sink = sinks.find((s) => s.id === owner) ?? sinks[sinks.length - 1]
  if (sink) sink.put(text)
  else drafts.append(RAVEN_THREAD, text)
}

/** Starts recording; owner = the composer whose mic was tapped (null: the one in front). */
export async function voiceStart(owner: number | null, ptt = false): Promise<void> {
  if (voice.phase !== 'idle') return
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined
  if (!window.isSecureContext || !md?.getUserMedia || typeof MediaRecorder === 'undefined') {
    toast('Voice input needs Valkyrie on its https address, in a browser that can record.', { ms: 6000 })
    return
  }
  stopAsked = false
  setVoice({ phase: 'starting', owner, ptt, since: Date.now() })
  let stream: MediaStream
  try {
    stream = await md.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
  } catch (e) {
    setVoice({ phase: 'idle', owner: null, ptt: false })
    toast(micError(e), { ms: 7000 })
    return
  }
  // he let go of the key while the permission prompt was up: nothing to record
  if (stopAsked) {
    for (const t of stream.getTracks()) t.stop()
    setVoice({ phase: 'idle', owner: null, ptt: false })
    return
  }
  const type = MIME_TRY.find((t) => MediaRecorder.isTypeSupported?.(t)) ?? ''
  const mr = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
  const chunks: Blob[] = []
  mr.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data) }
  mr.onstop = () => { void finish() }
  const started = Date.now()
  rec = { mr, stream, chunks, type: mr.mimeType || type || 'audio/webm', started, timer: window.setTimeout(() => voiceStop(), MAX_CLIP_MS) }
  mr.start(1000)
  setVoice({ phase: 'recording', since: started })
}

/** Stops recording; the words follow once odin has written them down. */
export function voiceStop(): void {
  if (voice.phase === 'starting') {
    stopAsked = true
    return
  }
  if (voice.phase !== 'recording' || !rec) return
  if (rec.mr.state !== 'inactive') rec.mr.stop()
}

export function voiceToggle(owner: number | null): void {
  if (voice.phase === 'idle') void voiceStart(owner)
  else voiceStop()
}

async function finish(): Promise<void> {
  const r = rec
  rec = null
  if (!r) return
  window.clearTimeout(r.timer)
  for (const t of r.stream.getTracks()) t.stop()
  const owner = voice.owner
  const clip = new Blob(r.chunks, { type: r.type })
  if (Date.now() - r.started < 500 || clip.size < 600) {
    setVoice({ phase: 'idle', owner: null, ptt: false })
    toast('Too short to write down. Hold the key, or keep the mic on, while you talk.', { ms: 4000 })
    return
  }
  setVoice({ phase: 'writing' })
  try {
    const text = await transcribeRaven(clip)
    if (text) deliver(text, owner)
    else toast('Nothing was heard in that recording.', { ms: 4000 })
  } catch (e) {
    toast(apiErrorText(e, 'Could not write the recording down'), { ms: 6000 })
  } finally {
    setVoice({ phase: 'idle', owner: null, ptt: false })
  }
}

// ---------- push to talk: the key, per device ----------

export type PttKey = { code: string; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }
const PTT_STORE = 'valkyrie-raven-ptt'
const PTT_EVENT = 'valkyrie-raven-ptt'
/** F8: free in Chrome, Edge, the desktop app and Windows, and not one of his keyboard's macro keys. */
export const DEFAULT_PTT: PttKey = { code: 'F8', ctrl: false, alt: false, shift: false, meta: false }

function readPtt(): PttKey | null {
  try {
    const raw = localStorage.getItem(PTT_STORE)
    if (raw === null) return DEFAULT_PTT
    if (raw === 'off') return null
    const k = JSON.parse(raw) as Partial<PttKey>
    return typeof k.code === 'string' && k.code ? { code: k.code, ctrl: !!k.ctrl, alt: !!k.alt, shift: !!k.shift, meta: !!k.meta } : DEFAULT_PTT
  } catch {
    return DEFAULT_PTT
  }
}

/** The push-to-talk key on this device (null: off) and its setter. */
export function usePttKey(): [PttKey | null, (k: PttKey | null) => void] {
  const [k, setK] = useState<PttKey | null>(readPtt)
  useEffect(() => {
    const on = () => setK(readPtt())
    window.addEventListener(PTT_EVENT, on)
    window.addEventListener('storage', on)
    return () => { window.removeEventListener(PTT_EVENT, on); window.removeEventListener('storage', on) }
  }, [])
  const set = useCallback((next: PttKey | null) => {
    try { localStorage.setItem(PTT_STORE, next ? JSON.stringify(next) : 'off') } catch { /* private mode: this session only */ }
    setK(next)
    window.dispatchEvent(new Event(PTT_EVENT))
  }, [])
  return [k, set]
}

/** "F8", "Ctrl+Alt+K". */
export function pttLabel(k: PttKey): string {
  const key = k.code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num ')
  return [k.ctrl && 'Ctrl', k.alt && 'Alt', k.shift && 'Shift', k.meta && 'Win', key].filter(Boolean).join('+')
}

/** A key that never types: a function key, or anything held with Ctrl, Alt or Win. */
export const pttAllowed = (k: PttKey): boolean => /^F(?:[1-9]|1\d|2[0-4])$/.test(k.code) || k.ctrl || k.alt || k.meta

export const pttMatches = (e: KeyboardEvent, k: PttKey): boolean =>
  e.code === k.code && e.ctrlKey === k.ctrl && e.altKey === k.alt && e.shiftKey === k.shift && e.metaKey === k.meta
