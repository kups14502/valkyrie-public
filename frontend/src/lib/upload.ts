import { api } from './api'

// Pictures and videos from the phone into C:\Thor\uploads on thor, so a Claude
// session there can read them by path.
//
// A file goes up in 8 MB chunks. Cloudflare refuses a body over 100 MB, which a
// minute of iPhone video passes easily, and a dropped connection on a phone
// then costs one chunk instead of the whole file. thor appends each chunk and
// answers with how much it holds, so a retry always resumes from thor's count,
// never from a guess. The route is backend/src/routes/hostLaunch.ts; the writer
// is Receive-UploadChunk in thor's Start-LauncherAgent.ps1.

// Must not exceed UPLOAD_CHUNK_MAX in hostLaunch.ts.
const CHUNK = 8 * 1024 * 1024
const RETRIES = 4

export type Uploaded = { name: string; path: string; size: number }

type ChunkReply = { done: boolean; received: number; name?: string; path?: string; size?: number }

// crypto.randomUUID only exists in a secure context, and on the tailnet the app
// is plain http. getRandomValues exists everywhere.
function uploadId(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type HttpError = { response?: { status?: number; data?: { error?: string; received?: unknown } }; message?: string }

export function uploadError(e: unknown): string {
  const err = e as HttpError
  return err?.response?.data?.error || err?.message || 'upload failed'
}

export async function uploadToThor(
  file: File,
  onProgress?: (sent: number, total: number) => void,
): Promise<Uploaded> {
  const total = file.size
  if (!total) throw new Error(`${file.name} is empty`)
  const id = uploadId()
  let offset = 0
  let failures = 0
  for (;;) {
    const start = offset
    const end = Math.min(start + CHUNK, total)
    try {
      const r = await api.post<ChunkReply>('/hosts/thor/upload', file.slice(start, end), {
        params: { id, name: file.name, offset: start, total },
        headers: { 'Content-Type': 'application/octet-stream' },
        timeout: 180_000,
        onUploadProgress: (e) => onProgress?.(start + (e.loaded ?? 0), total),
      })
      failures = 0
      const d = r.data
      if (d.done && d.path && d.name) {
        onProgress?.(total, total)
        return { name: d.name, path: d.path, size: d.size ?? total }
      }
      offset = d.received
    } catch (e) {
      const res = (e as HttpError).response
      const status = res?.status
      const received = res?.data?.received
      // thor says where it really is: carry on from there.
      if (status === 409 && typeof received === 'number') { offset = received; continue }
      // A refusal (bad type, too big, no space) will not change on a retry.
      if (status && status < 500 && status !== 408 && status !== 400) throw e
      if (status === 400 && typeof received !== 'number') throw e
      if (++failures > RETRIES) throw e
      if (typeof received === 'number') offset = received
      await sleep(1000 * failures)
    }
  }
}
