import type { RavenFile } from '../../lib/ravenApi'

// The unsent message to Raven: the text he typed or dictated and the files he attached, kept per thread (Raven has
// one conversation, RAVEN_THREAD) in this device's localStorage. It survives a tab switch, a screen that unmounts,
// a reload and an app restart; the phone, the iPad and the desktop app each keep their own (localStorage never
// leaves the device). Every composer on the thread (the Raven tab, the quick sheet, the Dashboard's Raven block)
// shows the same draft. Only a send clears it, and only what that send carried. A file goes up to odin as soon as
// it is picked and is kept by its stored id, so it stays attached across a reload; one still uploading when the
// page went comes back as a chip saying to attach it again. Another window of the app on this device (a pop-out)
// follows through the storage event. No React here: kit/ravenStore.ts makes the app's store and the hook, and
// e2e/raven-draft-unit.mjs tests this in node.

export const RAVEN_THREAD = 'raven'
export const DRAFT_PREFIX = 'valkyrie-raven-draft:'

export type DraftFile = {
  /** the file's id in the draft, the same in every window */
  key: string
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
  /** came back from storage with no bytes behind it: it can only be removed */
  lost?: boolean
}

export type DraftState = { text: string; files: DraftFile[] }

/** What a send carried: the box's text as it was, and the ids of the files that went. */
export type DraftSnap = { text: string; ids: string[] }

type KeyStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export type DraftStoreOpts = {
  storage: KeyStore | null
  upload: (file: File, onProgress: (sent: number) => void, signal: AbortSignal) => Promise<RavenFile>
  maxBytes: number
  preview?: (f: File) => string | undefined
  revoke?: (url: string) => void
}

const EMPTY: DraftState = { text: '', files: [] }

/** The ids of the files that landed. */
export const draftIds = (s: DraftState): string[] => s.files.filter((f) => f.state === 'done' && f.file).map((f) => (f.file as RavenFile).id)

function serialize(s: DraftState): string | null {
  if (!s.text && !s.files.length) return null
  // no progress and no object URL: neither means anything after a reload, and a write per progress tick is waste
  const files = s.files.map((f) => ({ key: f.key, name: f.name, size: f.size, mime: f.mime, state: f.state, file: f.file, error: f.error, lost: f.lost }))
  return JSON.stringify({ v: 1, text: s.text, files })
}

/** A stored draft. `keepUp`: another window's uploads still on their way are left out (that window writes them once they land). */
function parse(raw: string | null, keepUp: boolean): DraftState {
  if (!raw) return EMPTY
  try {
    const j = JSON.parse(raw) as { text?: unknown; files?: unknown }
    const text = typeof j?.text === 'string' ? j.text : ''
    const files: DraftFile[] = []
    for (const x of Array.isArray(j?.files) ? (j.files as Partial<DraftFile>[]) : []) {
      if (!x || typeof x.key !== 'string' || typeof x.name !== 'string') continue
      const size = Number(x.size) || 0
      const base = { key: x.key, name: x.name, size, mime: typeof x.mime === 'string' ? x.mime : '' }
      if (x.state === 'done' && x.file && typeof x.file.id === 'string') files.push({ ...base, state: 'done', sent: size, file: x.file })
      else if (x.state === 'up' && !keepUp) continue
      // its bytes went with the page that picked it
      else files.push({ ...base, state: 'err', sent: 0, error: x.state === 'up' ? 'attach it again' : x.error || 'failed', lost: true })
    }
    return { text, files }
  } catch {
    return EMPTY
  }
}

function uploadError(e: unknown): string {
  const err = e as { response?: { status?: number; data?: { error?: string } }; message?: string }
  return err.response?.data?.error || (err.response?.status ? `${err.response.status}` : err.message) || 'upload failed'
}

let keySeq = 0
const newKey = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${++keySeq}`

export type DraftStore = ReturnType<typeof createDraftStore>

export function createDraftStore(opts: DraftStoreOpts) {
  const states = new Map<string, DraftState>()
  // what this window last wrote (or read) per thread, so a write that changes nothing is skipped
  const written = new Map<string, string | null>()
  // the picked files' bytes, for Retry, and their uploads, for remove
  const raw = new Map<string, { file: File; ac: AbortController }>()
  const subs = new Set<() => void>()

  const read = (thread: string): string | null => {
    try { return opts.storage?.getItem(DRAFT_PREFIX + thread) ?? null } catch { return null }
  }

  const get = (thread: string): DraftState => {
    let s = states.get(thread)
    if (!s) {
      const stored = read(thread)
      written.set(thread, stored)
      s = parse(stored, true)
      states.set(thread, s)
    }
    return s
  }

  const save = (thread: string, s: DraftState) => {
    const next = serialize(s)
    if (next === written.get(thread)) return
    written.set(thread, next)
    try {
      if (next === null) opts.storage?.removeItem(DRAFT_PREFIX + thread)
      else opts.storage?.setItem(DRAFT_PREFIX + thread, next)
    } catch { /* storage full or off (private mode): the draft lasts this session */ }
  }

  const commit = (thread: string, next: DraftState, persist = true) => {
    states.set(thread, next)
    if (persist) save(thread, next)
    subs.forEach((f) => f())
  }

  const release = (f: DraftFile) => {
    raw.get(f.key)?.ac.abort()
    raw.delete(f.key)
    if (f.preview) opts.revoke?.(f.preview)
  }

  const patch = (thread: string, key: string, p: Partial<DraftFile>) => {
    const s = get(thread)
    if (!s.files.some((f) => f.key === key)) return
    commit(thread, { ...s, files: s.files.map((f) => (f.key === key ? { ...f, ...p } : f)) })
  }

  const start = (thread: string, key: string, file: File) => {
    raw.get(key)?.ac.abort()
    const ac = new AbortController()
    raw.set(key, { file, ac })
    patch(thread, key, { state: 'up', sent: 0, error: undefined })
    opts.upload(file, (sent) => { if (!ac.signal.aborted) patch(thread, key, { sent }) }, ac.signal).then(
      (rf) => { if (!ac.signal.aborted) patch(thread, key, { state: 'done', sent: file.size, file: rf }) },
      (e: unknown) => { if (!ac.signal.aborted) patch(thread, key, { state: 'err', error: uploadError(e) }) },
    )
  }

  const setText = (thread: string, text: string): void => {
    const s = get(thread)
    if (s.text !== text) commit(thread, { ...s, text })
  }

  return {
    subscribe(f: () => void): () => void {
      subs.add(f)
      return () => { subs.delete(f) }
    },
    get,
    setText,
    /** Words from a recording join the end of the box, for him to read and edit. */
    append(thread: string, words: string): void {
      const cur = get(thread).text.replace(/\s+$/, '')
      setText(thread, cur ? `${cur} ${words}` : words)
    },
    add(thread: string, list: FileList | File[]): void {
      const picked = Array.from(list)
      if (!picked.length) return
      const rows: DraftFile[] = []
      const go: [string, File][] = []
      for (const f of picked) {
        const key = newKey()
        const tooBig = f.size > opts.maxBytes
        const empty = !f.size
        rows.push({
          key, name: f.name || 'file', size: f.size, mime: f.type, sent: 0, preview: opts.preview?.(f),
          state: tooBig || empty ? 'err' : 'up',
          error: tooBig ? 'over 50 MB' : empty ? 'empty' : undefined,
        })
        if (!tooBig && !empty) go.push([key, f])
      }
      const s = get(thread)
      commit(thread, { ...s, files: [...s.files, ...rows] })
      for (const [key, f] of go) start(thread, key, f)
    },
    remove(thread: string, key: string): void {
      const s = get(thread)
      const f = s.files.find((x) => x.key === key)
      if (!f) return
      release(f)
      commit(thread, { ...s, files: s.files.filter((x) => x.key !== key) })
    },
    retry(thread: string, key: string): void {
      const r = raw.get(key)
      const f = get(thread).files.find((x) => x.key === key)
      if (r && f && !f.lost) start(thread, key, r.file)
    },
    /** What a send takes now: the text as it is and the files that landed. */
    snapshot(thread: string): DraftSnap {
      const s = get(thread)
      return { text: s.text, ids: draftIds(s) }
    },
    /**
     * The send went: its text and files leave the draft. What he typed while it went stays (text that only grew
     * keeps the new part; text he changed stays whole); a file that failed or is still uploading stays.
     */
    markSent(thread: string, snap: DraftSnap): void {
      const s = get(thread)
      const text = s.text === snap.text ? '' : s.text.startsWith(snap.text) ? s.text.slice(snap.text.length).replace(/^\s+/, '') : s.text
      const went = new Set(snap.ids)
      const files = s.files.filter((f) => {
        const gone = f.state === 'done' && !!f.file && went.has(f.file.id)
        if (gone) release(f)
        return !gone
      })
      commit(thread, { text, files })
    },
    /**
     * Another window on this device wrote the thread's draft (the storage event; thread null: storage cleared).
     * Its text wins; a file both windows know stays as this window has it (its preview, its Retry, its upload);
     * this window's uploads still on their way stay. Never written back, so two windows never echo each other.
     */
    adopt(thread: string | null, stored: string | null): void {
      for (const t of thread === null ? [...states.keys()] : [thread]) {
        if (!states.has(t)) continue
        const cur = get(t)
        const inc = parse(stored, false)
        const mine = new Map(cur.files.map((f) => [f.key, f]))
        const files = inc.files.map((f) => mine.get(f.key) ?? f)
        for (const f of cur.files) if (f.state === 'up' && !files.some((x) => x.key === f.key)) files.push(f)
        for (const f of cur.files) if (!files.includes(f)) release(f)
        written.set(t, stored)
        commit(t, { text: inc.text, files }, false)
      }
    },
  }
}
