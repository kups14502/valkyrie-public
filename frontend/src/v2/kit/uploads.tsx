import { useRef, useSyncExternalStore, type ChangeEvent } from 'react'
import { Camera, Film, Image as ImageIcon, ImageUp } from 'lucide-react'
import { uploadError, uploadToThor } from '../../lib/upload'

// Pictures and videos from the phone to C:\Thor\uploads on thor, so a Claude
// session there can open them by path. The transfer is the classic panel's:
// lib/upload.ts sends each file in 8 MB chunks to POST /api/hosts/thor/upload
// and resumes from thor's own count. What v2 adds lives here: one queue for
// the whole app (the Dashboard block and the AI > Sessions button share it),
// a retry for a file that failed, a thumbnail per row, and the files that
// landed kept on this device (v2.uploads) with their paths. The rows and the
// button are kit/upload.tsx.

export type UpKind = 'image' | 'video'
export type UpState = 'queued' | 'up' | 'done' | 'err'

export type UpItem = {
  key: number
  /** the name as picked */
  name: string
  size: number
  sent: number
  state: UpState
  kind: UpKind
  /** when it was picked; when it landed, once done */
  at: number
  /** where thor saved it (the path a Claude session needs) */
  path?: string
  /** thor's file name: a time stamp, then the picked name cut to safe characters */
  saved?: string
  error?: string
  /** a failed file that can go again (its File is still held) */
  retry?: boolean
  /** a 96 px JPEG data URL, drawn on this device */
  thumb?: string
  /** the control that picked it: 'dashboard' | 'sessions' */
  from?: string
}

export const UP_ICONS = { camera: Camera, upload: ImageUp, image: ImageIcon, video: Film } as const

// thor's agent takes these and nothing else (415); checked here too, so a
// wrong file fails at once instead of after its first 8 MB. Must match
// $UploadExt in thor's Start-LauncherAgent.ps1.
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'heic', 'heif', 'gif', 'webp', 'tif', 'tiff', 'bmp']
const VIDEO_EXT = ['mov', 'mp4', 'm4v', '3gp', 'webm', 'avi', 'mkv']
// a picked file with no usable extension gets one from its type
const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/heif': 'heif', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/tiff': 'tiff', 'image/bmp': 'bmp',
  'video/quicktime': 'mov', 'video/mp4': 'mp4', 'video/x-m4v': 'm4v', 'video/3gpp': '3gp', 'video/webm': 'webm',
  'video/x-msvideo': 'avi', 'video/x-matroska': 'mkv',
}

const extOf = (name: string) => /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? ''
const kindOfExt = (ext: string): UpKind | null => (IMAGE_EXT.includes(ext) ? 'image' : VIDEO_EXT.includes(ext) ? 'video' : null)

/** The file as thor will take it: an extension added from the type when the name has none it knows. */
function withExt(f: File): File {
  if (kindOfExt(extOf(f.name))) return f
  const ext = MIME_EXT[f.type.toLowerCase()]
  if (!ext) return f
  return new File([f], `${f.name || 'upload'}.${ext}`, { type: f.type, lastModified: f.lastModified })
}

// ---------- the store: one list for the whole app ----------

const STORE = 'v2.uploads'
/** landed files kept on this device */
const KEEP = 20

type Saved = { name: string; size: number; kind: UpKind; at: number; path: string; saved?: string; thumb?: string }

function load(): UpItem[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORE) ?? '[]')
    if (!Array.isArray(raw)) return []
    const ok = raw.filter((r): r is Saved => !!r && typeof r === 'object'
      && typeof r.name === 'string' && typeof r.path === 'string' && typeof r.size === 'number' && typeof r.at === 'number')
      .slice(0, KEEP)
    return ok.map((r, k) => ({
      key: ok.length - k,
      name: r.name,
      size: r.size,
      sent: r.size,
      state: 'done' as const,
      kind: r.kind === 'video' ? 'video' as const : 'image' as const,
      at: r.at,
      path: r.path,
      saved: typeof r.saved === 'string' ? r.saved : undefined,
      thumb: typeof r.thumb === 'string' && r.thumb.startsWith('data:image/') ? r.thumb : undefined,
    }))
  } catch {
    return []
  }
}

function save(): void {
  const done: Saved[] = items.filter((i) => i.state === 'done' && i.path).slice(0, KEEP)
    .map(({ name, size, kind, at, path, saved, thumb }) => ({ name, size, kind, at, path: path as string, saved, thumb }))
  try {
    localStorage.setItem(STORE, JSON.stringify(done))
  } catch {
    // full: keep the paths, drop the pictures
    try { localStorage.setItem(STORE, JSON.stringify(done.map((d) => ({ ...d, thumb: undefined })))) } catch { /* storage off */ }
  }
}

/** newest first */
let items: UpItem[] = load()
let seq = items.length
/** the File behind each row still to send or to retry */
const files = new Map<number, File>()
const listeners = new Set<() => void>()
export type UploadSettled = (row: UpItem, ok: boolean) => void
const settles = new Set<UploadSettled>()

const emit = () => listeners.forEach((l) => l())
function setItems(next: UpItem[]): void {
  items = next
  emit()
}
function patch(key: number, p: Partial<UpItem>): void {
  setItems(items.map((i) => (i.key === key ? { ...i, ...p } : i)))
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

/** still to send: waiting in the queue or on its way */
export const upBusy = (i: UpItem) => i.state === 'queued' || i.state === 'up'

/** The list as it is now (for callbacks that run outside a render). */
export const uploadItems = (): UpItem[] => items

/** Calls `fn` each time a file lands or fails. Returns the unsubscribe. */
export function onUploadSettled(fn: UploadSettled): () => void {
  settles.add(fn)
  return () => { settles.delete(fn) }
}

/** Landed rows past KEEP leave the list, oldest first. */
function trim(): void {
  let n = 0
  const next = items.filter((i) => i.state !== 'done' || ++n <= KEEP)
  if (next.length !== items.length) setItems(next)
}

// One file at a time, in the order picked: thor's agent serves one request at
// a time, and a queue keeps the rows finishing top to bottom of a batch.
let chain: Promise<void> = Promise.resolve()

async function send(key: number): Promise<void> {
  const file = files.get(key)
  const row = items.find((i) => i.key === key)
  // dismissed while it waited
  if (!file || !row || row.state !== 'queued') return
  patch(key, { state: 'up', sent: 0, error: undefined })
  let last = 0
  try {
    const u = await uploadToThor(file, (sent, total) => {
      const t = performance.now()
      if (sent < total && t - last < 120) return
      last = t
      patch(key, { sent, size: total })
    })
    files.delete(key)
    patch(key, { state: 'done', sent: u.size, size: u.size, path: u.path, saved: u.name, at: Date.now(), retry: false })
    trim()
    save()
  } catch (e) {
    patch(key, { state: 'err', error: uploadError(e), retry: true })
  }
  const settled = items.find((i) => i.key === key)
  if (settled) settles.forEach((s) => s(settled, settled.state === 'done'))
}

function enqueue(key: number): void {
  chain = chain.then(() => send(key)).catch(() => {})
}

// Thumbnails are drawn one at a time beside the queue: a 12 MP photo decodes
// to about 50 MB, and a batch of them at once would push the phone hard.
let thumbs: Promise<void> = Promise.resolve()
const THUMB = 96

function draw(src: CanvasImageSource, w: number, h: number): string | undefined {
  if (!w || !h) return undefined
  const c = document.createElement('canvas')
  c.width = THUMB
  c.height = THUMB
  const g = c.getContext('2d')
  if (!g) return undefined
  const k = Math.max(THUMB / w, THUMB / h)
  g.drawImage(src, (THUMB - w * k) / 2, (THUMB - h * k) / 2, w * k, h * k)
  return c.toDataURL('image/jpeg', 0.72)
}

const within = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))])

async function thumbOf(file: File, kind: UpKind): Promise<string | undefined> {
  const url = URL.createObjectURL(file)
  try {
    if (kind === 'image') {
      const img = new Image()
      img.decoding = 'async'
      img.src = url
      await within(img.decode(), 8000)
      return draw(img, img.naturalWidth, img.naturalHeight)
    }
    const v = document.createElement('video')
    v.muted = true
    v.playsInline = true
    v.preload = 'auto'
    try {
      v.src = url
      await within(new Promise((res, rej) => { v.onloadeddata = res; v.onerror = rej }), 5000)
      const at = Math.min(0.5, (v.duration || 1) / 2)
      await within(new Promise((res) => { v.onseeked = res; v.currentTime = at }), 4000)
      return draw(v, v.videoWidth, v.videoHeight)
    } finally {
      v.removeAttribute('src')
      v.load()
    }
  } catch {
    // a format this browser cannot draw (HEIC outside Safari): the row keeps its icon
    return undefined
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Queues files picked or dropped, in the order given. `from` names the control. */
export function addUploads(list: File[], from: string): void {
  const rows: UpItem[] = []
  const now = Date.now()
  for (const f0 of list) {
    const f = withExt(f0)
    const kind = kindOfExt(extOf(f.name))
    const key = ++seq
    const error = !kind ? 'Only pictures and videos can go to thor' : f.size === 0 ? 'The file is empty' : undefined
    rows.push({ key, name: f.name, size: f.size, sent: 0, state: error ? 'err' : 'queued', kind: kind ?? 'image', at: now, from, error, retry: false })
    if (error || !kind) continue
    files.set(key, f)
    thumbs = thumbs.then(async () => {
      const thumb = await thumbOf(f, kind)
      if (!thumb || !items.some((i) => i.key === key)) return
      patch(key, { thumb })
      if (items.find((i) => i.key === key)?.state === 'done') save()
    })
  }
  if (!rows.length) return
  // the last one picked on top; the queue sends them in the order picked
  setItems([...[...rows].reverse(), ...items])
  for (const r of rows) if (r.state === 'queued') enqueue(r.key)
}

export function retryUpload(key: number): void {
  const row = items.find((i) => i.key === key)
  if (!row || row.state !== 'err' || !files.has(key)) return
  patch(key, { state: 'queued', sent: 0, error: undefined })
  enqueue(key)
}

/** Drops a row (never one on its way: the chunk loop cannot be stopped halfway). */
export function dismissUpload(key: number): void {
  const row = items.find((i) => i.key === key)
  if (!row || row.state === 'up') return
  files.delete(key)
  setItems(items.filter((i) => i.key !== key))
  if (row.state === 'done') save()
}

export function clearLanded(): void {
  setItems(items.filter((i) => i.state !== 'done'))
  save()
}

export function useUploads(): UpItem[] {
  return useSyncExternalStore(subscribe, () => items, () => items)
}

/** Overall progress of what is still to send: files left, and the percent of their bytes. */
export function uploadProgress(list: UpItem[]): { left: number; pct: number; failed: number } {
  const open = list.filter(upBusy)
  const size = open.reduce((n, i) => n + i.size, 0)
  const sent = open.reduce((n, i) => n + Math.min(i.sent, i.size), 0)
  return { left: open.length, pct: size ? Math.floor((sent / size) * 100) : 0, failed: list.filter((i) => i.state === 'err').length }
}

/**
 * The two hidden pickers: the camera (take one now, photo or video) and the
 * library (any number, from Photos or Files). Open them from a tap's click
 * event, which is what iOS needs to show the picker.
 */
export function useUploadPicker(from: string) {
  const cam = useRef<HTMLInputElement>(null)
  const lib = useRef<HTMLInputElement>(null)
  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    // copy before clearing: the FileList empties with the value, and clearing lets the same photo go twice
    const list = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (list.length) addUploads(list, from)
  }
  const inputs = (
    <>
      <input ref={cam} type="file" accept="image/*,video/*" capture="environment" hidden onChange={onPick} data-upload="camera" />
      <input ref={lib} type="file" accept="image/*,video/*" multiple hidden onChange={onPick} data-upload="files" />
    </>
  )
  return { inputs, openCamera: () => cam.current?.click(), openFiles: () => lib.current?.click() }
}
