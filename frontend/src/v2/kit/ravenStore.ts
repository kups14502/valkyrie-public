import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchImgToken, imgTrusted } from '../../lib/api'
import {
  RAVEN_FILE_MAX, fetchMsgCount, fetchRaven, ravenFileUrl, uploadRavenFile, waitMsgChange, type RavenFile, type RavenPage,
} from '../../lib/ravenApi'
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

export type DraftFile = {
  key: number
  name: string
  size: number
  mime: string
  state: 'up' | 'done' | 'err'
  sent: number
  /** the stored file, once it landed */
  file?: RavenFile
  error?: string
  /** an object URL for a picture, drawn on this device */
  preview?: string
}

let draftSeq = 0

export type RavenDraft = {
  text: string
  setText: (t: string) => void
  files: DraftFile[]
  add: (list: FileList | File[]) => void
  remove: (key: number) => void
  retry: (key: number) => void
  /** clears the text and the files (after a send) */
  clear: () => void
  /** a file is still on its way */
  uploading: boolean
  /** there is something to send and nothing still uploading */
  ready: boolean
  /** the ids of the files that landed */
  ids: string[]
}

/** The composer's text and attachments; each file goes up to odin as soon as it is picked. */
export function useRavenDraft(): RavenDraft {
  const [text, setText] = useState('')
  const [files, setFiles] = useState<DraftFile[]>([])
  const raw = useRef(new Map<number, { file: File; ac: AbortController }>())

  const patch = useCallback((key: number, p: Partial<DraftFile>) => {
    setFiles((cur) => cur.map((f) => (f.key === key ? { ...f, ...p } : f)))
  }, [])

  const start = useCallback((key: number, file: File) => {
    const ac = new AbortController()
    raw.current.set(key, { file, ac })
    patch(key, { state: 'up', sent: 0, error: undefined })
    uploadRavenFile(file, (sent) => patch(key, { sent }), ac.signal).then(
      (rf) => patch(key, { state: 'done', sent: file.size, file: rf }),
      (e: unknown) => {
        if (ac.signal.aborted) return
        const err = e as { response?: { status?: number; data?: { error?: string } }; message?: string }
        const why = err.response?.data?.error || (err.response?.status ? `${err.response.status}` : err.message) || 'upload failed'
        patch(key, { state: 'err', error: why })
      },
    )
  }, [patch])

  const add = useCallback((list: FileList | File[]) => {
    const picked = Array.from(list)
    if (!picked.length) return
    const rows: DraftFile[] = []
    const go: [number, File][] = []
    for (const f of picked) {
      const key = ++draftSeq
      const preview = f.type.startsWith('image/') && f.size < 40 * 1024 * 1024 ? URL.createObjectURL(f) : undefined
      const tooBig = f.size > RAVEN_FILE_MAX
      const empty = !f.size
      rows.push({
        key, name: f.name || 'file', size: f.size, mime: f.type, sent: 0, preview,
        state: tooBig || empty ? 'err' : 'up',
        error: tooBig ? 'over 50 MB' : empty ? 'empty' : undefined,
      })
      if (!tooBig && !empty) go.push([key, f])
    }
    setFiles((cur) => [...cur, ...rows])
    for (const [key, f] of go) start(key, f)
  }, [start])

  const drop = (f: DraftFile) => {
    raw.current.get(f.key)?.ac.abort()
    raw.current.delete(f.key)
    if (f.preview) URL.revokeObjectURL(f.preview)
  }

  const remove = useCallback((key: number) => {
    setFiles((cur) => {
      const f = cur.find((x) => x.key === key)
      if (f) drop(f)
      return cur.filter((x) => x.key !== key)
    })
  }, [])

  const retry = useCallback((key: number) => {
    const r = raw.current.get(key)
    if (r) start(key, r.file)
  }, [start])

  const clear = useCallback(() => {
    setText('')
    setFiles((cur) => {
      // the sent line shows the stored files, so the previews go; a file that failed stays, with its Retry
      for (const f of cur) {
        if (f.state === 'err') continue
        raw.current.delete(f.key)
        if (f.preview) URL.revokeObjectURL(f.preview)
      }
      return cur.filter((f) => f.state === 'err')
    })
  }, [])

  // a draft that goes away (the sheet closes) stops its uploads
  useEffect(() => {
    const map = raw.current
    return () => { for (const r of map.values()) r.ac.abort() }
  }, [])

  const uploading = files.some((f) => f.state === 'up')
  const ids = files.filter((f) => f.state === 'done' && f.file).map((f) => (f.file as RavenFile).id)
  const ready = !uploading && (text.trim() !== '' || ids.length > 0)
  return { text, setText, files, add, remove, retry, clear, uploading, ready, ids }
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
