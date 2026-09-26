import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent } from 'react'
import { uploadError, uploadToThor, type Uploaded } from './upload'

// The state behind every "send to thor" button: two hidden file inputs, one for
// the camera (take one now) and one for the library (pick any number), and a
// row per file. The home screen draws it as a panel (components/ThorUpload.tsx);
// the terminal puts the same two buttons in its session bar and types each
// saved path into the prompt, so Claude on thor can open the file.

export type UploadItem = {
  key: number
  name: string
  sent: number
  total: number
  state: 'queued' | 'up' | 'done' | 'err'
  path?: string
  error?: string
}

type Options<T> = {
  // Called once per batch with what landed, and the tag the picker was opened
  // with (the terminal passes the session the files are meant for).
  onDone?: (done: Uploaded[], tag: T | undefined) => void
  // Finished rows drop off after this long. Unset keeps them.
  clearAfterMs?: number
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

export function uploadLine(i: UploadItem): string {
  if (i.state === 'queued') return `waiting · ${i.name}`
  if (i.state === 'up') return `${i.total ? Math.floor((i.sent / i.total) * 100) : 0}% · ${i.name}`
  if (i.state === 'err') return `${i.name}: ${i.error ?? 'failed'}`
  return i.path ?? i.name
}

export function useThorUpload<T = undefined>({ onDone, clearAfterMs }: Options<T> = {}) {
  const [items, setItems] = useState<UploadItem[]>([])
  const cameraRef = useRef<HTMLInputElement>(null)
  const filesRef = useRef<HTMLInputElement>(null)
  const tagRef = useRef<T | undefined>(undefined)
  const keyRef = useRef(0)
  // One batch at a time. thor's agent serves one request at a time anyway, and
  // a queue keeps the rows finishing in the order they were picked.
  const chainRef = useRef<Promise<void>>(Promise.resolve())
  const onDoneRef = useRef(onDone)
  useLayoutEffect(() => { onDoneRef.current = onDone })

  const run = useCallback((files: File[], tag: T | undefined) => {
    const patch = (key: number, p: Partial<UploadItem>) =>
      setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...p } : i)))
    const rows = files.map((f) => ({ key: ++keyRef.current, name: f.name, sent: 0, total: f.size, state: 'queued' as const }))
    setItems((prev) => [...prev, ...rows])
    chainRef.current = chainRef.current.then(async () => {
      const done: Uploaded[] = []
      for (let i = 0; i < files.length; i++) {
        const key = rows[i].key
        patch(key, { state: 'up' })
        try {
          const u = await uploadToThor(files[i], (sent, total) => patch(key, { sent, total }))
          patch(key, { state: 'done', sent: u.size, path: u.path, name: u.name })
          done.push(u)
        } catch (e) {
          patch(key, { state: 'err', error: uploadError(e) })
        }
      }
      if (done.length) onDoneRef.current?.(done, tag)
    })
  }, [])

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    // Copy before clearing: the FileList empties with the value, and clearing
    // is what lets the same photo be picked twice in a row.
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (files.length) run(files, tagRef.current)
  }

  const dismiss = useCallback((key: number) => setItems((prev) => prev.filter((i) => i.key !== key)), [])

  useEffect(() => {
    if (!clearAfterMs) return
    const finished = items.filter((i) => i.state === 'done')
    if (!finished.length) return
    const timer = setTimeout(() => {
      const gone = new Set(finished.map((i) => i.key))
      setItems((prev) => prev.filter((i) => !gone.has(i.key)))
    }, clearAfterMs)
    return () => clearTimeout(timer)
  }, [items, clearAfterMs])

  // Opened by click() from a real tap, which is what iOS needs to show the
  // picker. The camera input's `capture` goes straight to the camera, with the
  // photo and video switch; the other opens the library and takes several.
  const openCamera = useCallback((tag?: T) => { tagRef.current = tag; cameraRef.current?.click() }, [])
  const openFiles = useCallback((tag?: T) => { tagRef.current = tag; filesRef.current?.click() }, [])

  const inputs = (
    <>
      <input ref={cameraRef} type="file" accept="image/*,video/*" capture="environment" hidden onChange={onPick} />
      <input ref={filesRef} type="file" accept="image/*,video/*" multiple hidden onChange={onPick} />
    </>
  )

  const busy = items.some((i) => i.state === 'queued' || i.state === 'up')

  return { items, busy, inputs, openCamera, openFiles, dismiss }
}
