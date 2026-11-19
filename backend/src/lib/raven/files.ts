import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, openSync, readSync, closeSync, rmSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { DATA_DIR, openDb } from '../db.js'
// first, so agents.sqlite is opened with its schema before this file adds a table to it
import { nowIso } from '../agentsStore.js'
import { etLabel } from '../agents.js'
import type { RavenFile } from './types.js'

// Files Brendon attaches in the DM, stored on odin under <data dir>/raven-files
// as <id>.<ext>, listed in agents.sqlite raven_files. Kept 90 days. Raven reads
// them through its attachment tool (attachmentContent below); the UI shows
// them through GET /api/raven/files/:id.

const DIR = path.join(DATA_DIR, 'raven-files')
const KEEP_DAYS = 90
export const MAX_FILE_BYTES = 50 * 1024 * 1024
const FFMPEG = process.env.RAVEN_FFMPEG || '/usr/bin/ffmpeg'
const PDFTOTEXT = process.env.RAVEN_PDFTOTEXT || '/usr/bin/pdftotext'
const TEXT_CAP = 60_000
const IMAGE_MAX_PX = 1600
const IMAGE_MAX_BYTES = 1024 * 1024

const db = openDb('agents', '')
db.exec(`
  CREATE TABLE IF NOT EXISTS raven_files (
    id        TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    mime      TEXT NOT NULL,
    size      INTEGER NOT NULL,
    ext       TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ix_raven_files_at ON raven_files (createdAt);
`)

type Row = RavenFile & { ext: string }

const ID_RE = /^[a-f0-9]{24}$/
const MIME_RE = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/

const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
  avif: 'image/avif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', svg: 'image/svg+xml',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', webm: 'video/webm', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', log: 'text/plain', json: 'application/json',
  xml: 'application/xml', yaml: 'application/yaml', yml: 'application/yaml', html: 'text/html', htm: 'text/html', ps1: 'text/plain',
  zip: 'application/zip', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}
const MIME_EXT: Record<string, string> = Object.fromEntries(Object.entries(EXT_MIME).reverse().map(([e, m]) => [m, e]))

const toFile = (r: Row): RavenFile => ({ id: r.id, name: r.name, mime: r.mime, size: r.size, createdAt: r.createdAt })
const fileOnDisk = (r: Pick<Row, 'id' | 'ext'>) => path.join(DIR, `${r.id}.${r.ext}`)
const viewOnDisk = (id: string) => path.join(DIR, `${id}.view.jpg`)

/** A stored file and its absolute path on odin, or null when there is no such file. */
export function getRavenFile(id: string): { file: RavenFile; path: string } | null {
  if (!ID_RE.test(id)) return null
  const r = db.prepare('SELECT * FROM raven_files WHERE id = ?').get(id) as Row | undefined
  if (!r) return null
  const p = fileOnDisk(r)
  return existsSync(p) ? { file: toFile(r), path: p } : null
}

/** The files with these ids, in the order given; unknown ids are left out. */
export function ravenFilesFor(ids: string[]): RavenFile[] {
  return ids.map((id) => getRavenFile(id)?.file).filter((f): f is RavenFile => Boolean(f))
}

export function listRavenFiles(limit = 20): RavenFile[] {
  return (db.prepare('SELECT * FROM raven_files ORDER BY createdAt DESC LIMIT ?').all(Math.max(1, Math.min(100, limit))) as Row[]).map(toFile)
}

/** A file name a client sent (URI-encoded, since headers are ASCII), made safe to show and store. */
export function cleanFileName(raw: string | undefined): string {
  let s = String(raw ?? '')
  try { s = decodeURIComponent(s) } catch { /* not encoded */ }
  s = s.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return (s || 'file').slice(0, 180)
}

function extFor(name: string, mime: string): string {
  const e = path.extname(name).slice(1).toLowerCase()
  if (/^[a-z0-9]{1,8}$/.test(e)) return e
  return MIME_EXT[mime] ?? 'bin'
}

function mimeFor(header: string | undefined, name: string): string {
  const m = String(header ?? '').split(';')[0].trim().toLowerCase()
  if (m && m !== 'application/octet-stream' && MIME_RE.test(m)) return m
  return EXT_MIME[path.extname(name).slice(1).toLowerCase()] ?? 'application/octet-stream'
}

export class RavenFileError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

/** Streams an upload to disk (never buffered whole) and records it. Over the cap: 413, nothing kept. */
export async function saveRavenFile(src: Readable, opts: { name?: string; mime?: string; maxBytes?: number }): Promise<RavenFile> {
  mkdirSync(DIR, { recursive: true })
  const name = cleanFileName(opts.name)
  const mime = mimeFor(opts.mime, name)
  const ext = extFor(name, mime)
  const id = randomBytes(12).toString('hex')
  const dest = fileOnDisk({ id, ext })
  const max = opts.maxBytes ?? MAX_FILE_BYTES
  let size = 0
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length
      if (size > max) cb(new RavenFileError(413, `a file can be at most ${Math.round(max / 1024 / 1024)} MB`))
      else cb(null, chunk)
    },
  })
  try {
    await pipeline(src, counter, createWriteStream(dest, { mode: 0o600 }))
  } catch (e) {
    rmSync(dest, { force: true })
    if (e instanceof RavenFileError) throw e
    throw new RavenFileError(400, 'the upload did not finish')
  }
  if (size === 0) {
    rmSync(dest, { force: true })
    throw new RavenFileError(400, 'the file is empty')
  }
  const createdAt = nowIso()
  db.prepare('INSERT INTO raven_files (id, name, mime, size, ext, createdAt) VALUES (?, ?, ?, ?, ?, ?)').run(id, name, mime, size, ext, createdAt)
  return { id, name, mime, size, createdAt }
}

/** Files older than 90 days go, rows and bytes. */
export function pruneRavenFiles(days = KEEP_DAYS): number {
  const cut = new Date(Date.now() - days * 86_400_000).toISOString()
  const old = db.prepare('SELECT * FROM raven_files WHERE createdAt < ?').all(cut) as Row[]
  for (const r of old) {
    rmSync(fileOnDisk(r), { force: true })
    rmSync(viewOnDisk(r.id), { force: true })
  }
  db.prepare('DELETE FROM raven_files WHERE createdAt < ?').run(cut)
  return old.length
}

// ------------------------------------------------------------ reading ----

export const humanSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`)

const MODEL_IMAGES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const TEXT_MIMES = new Set(['application/json', 'application/xml', 'application/yaml', 'application/x-yaml', 'application/javascript', 'application/x-sh', 'application/csv'])
const TEXT_EXTS = new Set(['txt', 'md', 'csv', 'log', 'json', 'xml', 'yaml', 'yml', 'ps1', 'psm1', 'sh', 'ts', 'tsx', 'js', 'mjs', 'py', 'sql', 'ini', 'conf', 'html', 'htm', 'css', 'eml'])

/** Width and height from the first bytes of a PNG, JPEG, GIF or WebP; null when unknown. */
export function imageSize(buf: Buffer): { w: number; h: number } | null {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
  if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'GIF') return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) }
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buf.toString('ascii', 12, 16)
    if (kind === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) }
    if (kind === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff }
    if (kind === 'VP8L') {
      const b = buf.readUInt32LE(21)
      return { w: 1 + (b & 0x3fff), h: 1 + ((b >> 14) & 0x3fff) }
    }
    return null
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue }
      const m = buf[i + 1]
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue }
      const len = buf.readUInt16BE(i + 2)
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) }
      i += 2 + len
    }
  }
  return null
}

function head(file: string, n: number): Buffer {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(n)
    const got = readSync(fd, buf, 0, n, 0)
    return buf.subarray(0, got)
  } finally {
    closeSync(fd)
  }
}

function exec(file: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))))
  })
}

/**
 * The first bytes are a real image (PNG, JPEG, GIF, WebP, BMP, TIFF, HEIC or AVIF). ffmpeg picks its
 * reader from the content, not the name, so a playlist or concat list named photo.png would have it
 * open other files on this host: only a real image is handed to it.
 */
export function looksLikeImage(buf: Buffer): boolean {
  const a = (i: number, s: string) => buf.length >= i + s.length && buf.toString('latin1', i, i + s.length) === s
  return a(0, '\x89PNG') || (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) || a(0, 'GIF8')
    || (a(0, 'RIFF') && a(8, 'WEBP')) || a(0, 'BM') || a(0, 'II*\0') || a(0, 'MM\0*') || a(4, 'ftyp')
}

/** A JPEG at most 1600 px on its long side, made once and kept next to the original. */
async function viewImage(src: string, id: string): Promise<string | null> {
  const out = viewOnDisk(id)
  if (existsSync(out) && statSync(out).size > 0) return out
  if (!existsSync(FFMPEG) || !looksLikeImage(head(src, 16))) return null
  try {
    await exec(FFMPEG, ['-v', 'error', '-y', '-i', src, '-frames:v', '1',
      '-vf', `scale='min(${IMAGE_MAX_PX},iw)':'min(${IMAGE_MAX_PX},ih)':force_original_aspect_ratio=decrease`, '-q:v', '4', out], 60_000)
    return existsSync(out) && statSync(out).size > 0 ? out : null
  } catch {
    rmSync(out, { force: true })
    return null
  }
}

export type AttachmentContent =
  | { kind: 'image'; data: string; mimeType: string; note: string }
  | { kind: 'text'; text: string }

/** What Raven's attachment tool hands the model for one file. */
export async function attachmentContent(id: string): Promise<AttachmentContent | null> {
  const got = getRavenFile(id)
  if (!got) return null
  const { file, path: p } = got
  const about = `${file.name} (${file.mime}, ${humanSize(file.size)}, sent ${etLabel(file.createdAt)})`
  const ext = path.extname(file.name).slice(1).toLowerCase()

  if (file.mime.startsWith('image/') && file.mime !== 'image/svg+xml') {
    const dims = MODEL_IMAGES.has(file.mime) ? imageSize(head(p, 256 * 1024)) : null
    const fits = dims && dims.w <= IMAGE_MAX_PX && dims.h <= IMAGE_MAX_PX && file.size <= IMAGE_MAX_BYTES
    if (fits) return { kind: 'image', data: (await readFile(p)).toString('base64'), mimeType: file.mime, note: about }
    const view = await viewImage(p, file.id)
    if (view) return { kind: 'image', data: (await readFile(view)).toString('base64'), mimeType: 'image/jpeg', note: `${about}, shown downscaled to at most ${IMAGE_MAX_PX} px` }
    if (MODEL_IMAGES.has(file.mime) && file.size <= 5 * 1024 * 1024) {
      return { kind: 'image', data: (await readFile(p)).toString('base64'), mimeType: file.mime, note: about }
    }
    return { kind: 'text', text: `${about}. The image could not be converted for viewing on this host.` }
  }

  if (file.mime === 'application/pdf') {
    if (!existsSync(PDFTOTEXT)) return { kind: 'text', text: `${about}. pdftotext is not installed on this host, so the text cannot be read.` }
    try {
      const text = await exec(PDFTOTEXT, ['-layout', '-enc', 'UTF-8', p, '-'], 60_000)
      const cut = text.length > TEXT_CAP
      return { kind: 'text', text: `${about}\n\n${text.slice(0, TEXT_CAP)}${cut ? `\n\n[cut at 60 KB of ${Math.round(text.length / 1024)} KB of text]` : ''}` }
    } catch {
      return { kind: 'text', text: `${about}. The PDF text could not be read (scanned, or protected).` }
    }
  }

  if (file.mime.startsWith('text/') || TEXT_MIMES.has(file.mime) || TEXT_EXTS.has(ext)) {
    const buf = head(p, TEXT_CAP)
    return { kind: 'text', text: `${about}\n\n${buf.toString('utf8')}${file.size > TEXT_CAP ? `\n\n[cut at 60 KB of ${humanSize(file.size)}]` : ''}` }
  }

  return { kind: 'text', text: `${about}. This kind of file cannot be read here; only its name, type and size are known.` }
}
