import type { Request } from 'express'
import { AgentError } from '../agentsStore.js'

// Voice input for the Raven composer: the app records a clip (webm/opus in
// Chrome and the desktop app, mp4/aac on iOS) and POSTs it raw to
// /api/raven/transcribe; this hands it to the whisper.cpp server on this host
// (scripts/valkyrie-whisper.service, loopback :8771, ffmpeg converts) and
// answers the words. Nothing is kept: the clip lives only in memory.

const WHISPER_URL = process.env.RAVEN_WHISPER_URL || 'http://127.0.0.1:8771'
export const VOICE_MAX_BYTES = 25 * 1024 * 1024
const TIMEOUT_MS = Number(process.env.RAVEN_WHISPER_TIMEOUT_MS || 120_000)
const AUDIO_RE = /^(?:audio\/[\w.+-]+|video\/(?:webm|mp4|quicktime))(?:;.*)?$/i

const EXT: [RegExp, string][] = [[/webm/i, 'webm'], [/ogg|opus/i, 'ogg'], [/mp4|m4a|aac|quicktime/i, 'm4a'], [/wav/i, 'wav'], [/mpeg|mp3/i, 'mp3']]

/** The clip in the request body, up to 25 MB. */
export async function readClip(req: Request): Promise<{ data: Buffer; mime: string }> {
  const mime = String(req.headers['content-type'] ?? '').trim()
  if (!AUDIO_RE.test(mime)) throw new AgentError(400, 'send the recording as audio')
  const len = Number(req.headers['content-length'])
  if (Number.isFinite(len) && len > VOICE_MAX_BYTES) throw new AgentError(413, 'the recording is over 25 MB')
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > VOICE_MAX_BYTES) throw new AgentError(413, 'the recording is over 25 MB')
    chunks.push(c as Buffer)
  }
  if (size < 600) throw new AgentError(400, 'the recording is empty')
  return { data: Buffer.concat(chunks), mime }
}

/** Whisper's markers for no speech, and its line breaks, out. */
export function cleanTranscript(raw: string): string {
  return raw
    .replace(/\[(?:BLANK_AUDIO|MUSIC|NOISE|SOUND|silence|inaudible)[^\]]*\]/gi, ' ')
    .replace(/\((?:silence|music|inaudible|no speech)[^)]*\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The words in a clip, from the whisper server on this host. */
export async function transcribe(data: Buffer, mime: string): Promise<string> {
  const ext = EXT.find(([re]) => re.test(mime))?.[1] ?? 'webm'
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(data)], { type: mime.split(';')[0] }), `clip.${ext}`)
  form.append('response_format', 'json')
  form.append('temperature', '0.0')
  let r: Response
  try {
    r = await fetch(`${WHISPER_URL}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (e) {
    const why = (e as Error).name === 'TimeoutError' ? 'it took too long' : 'the transcriber on odin is not running'
    throw new AgentError(502, `could not write the recording down: ${why}`)
  }
  const body = (await r.json().catch(() => null)) as { text?: unknown; error?: unknown } | null
  if (!r.ok || !body || typeof body.text !== 'string') {
    throw new AgentError(502, `could not write the recording down${body?.error ? `: ${String(body.error).slice(0, 160)}` : ''}`)
  }
  return cleanTranscript(body.text)
}
