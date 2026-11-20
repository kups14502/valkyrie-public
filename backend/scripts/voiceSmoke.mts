/**
 * Voice input end to end on odin: POST /api/raven/transcribe with a real recording, through the real route, to the
 * whisper server on this host (scripts/valkyrie-whisper.service, loopback :8771). Needs that service running and
 * ffmpeg; makes its own webm/opus and mp4/aac clips from whisper.cpp's sample. Nothing is stored anywhere.
 *
 *   VALKYRIE_DATA_DIR=$(mktemp -d) node --import tsx scripts/voiceSmoke.mts
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import express from 'express'

if (!process.env.VALKYRIE_DATA_DIR || process.env.VALKYRIE_DATA_DIR.includes('valkyrie/backend/data')) {
  console.error('voiceSmoke: set VALKYRIE_DATA_DIR to a scratch directory')
  process.exit(2)
}
const dir = mkdtempSync(path.join(tmpdir(), 'voice-smoke-'))
const sample = path.join(homedir(), 'whisper.cpp', 'samples', 'jfk.wav')
const webm = path.join(dir, 'clip.webm')
const m4a = path.join(dir, 'clip.m4a')
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', sample, '-c:a', 'libopus', '-b:a', '32k', webm])
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', sample, '-c:a', 'aac', '-b:a', '64k', m4a])

const app = express()
app.use('/api', (await import('../src/routes/raven.ts')).default)
const srv = app.listen(0)
const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}/api`

let pass = 0
let fail = 0
const check = (name: string, ok: unknown, got?: unknown) => {
  if (ok) { pass++; console.log(`ok   ${name}`) } else { fail++; console.log(`FAIL ${name}${got === undefined ? '' : `: ${JSON.stringify(got).slice(0, 400)}`}`) }
}
const post = async (body: Buffer, type: string) => {
  const t0 = Date.now()
  const r = await fetch(`${base}/raven/transcribe`, { method: 'POST', headers: { 'content-type': type }, body: new Uint8Array(body) })
  return { status: r.status, body: (await r.json().catch(() => null)) as { text?: string; error?: string } | null, ms: Date.now() - t0 }
}

let r = await post(readFileSync(webm), 'audio/webm;codecs=opus')
check(`webm/opus (Chrome, the desktop app): the words come back (${r.ms} ms)`, r.status === 200 && /ask not what your country can do for you/i.test(r.body?.text ?? '') && !/\n/.test(r.body?.text ?? ''), r)
r = await post(readFileSync(m4a), 'audio/mp4')
check(`mp4/aac (iOS Safari): the words come back (${r.ms} ms)`, r.status === 200 && /ask what you can do for your country/i.test(r.body?.text ?? ''), r)
r = await post(Buffer.from('{"text":"x"}'), 'application/json')
check('not audio: 400', r.status === 400 && /audio/.test(r.body?.error ?? ''), r)
r = await post(Buffer.alloc(100), 'audio/webm')
check('an empty recording: 400', r.status === 400 && /empty/.test(r.body?.error ?? ''), r)
const voice = await import('../src/lib/raven/voice.ts')
check('whisper markers and line breaks come out', voice.cleanTranscript(' [BLANK_AUDIO]\n Add oat milk\n (silence) ') === 'Add oat milk', voice.cleanTranscript(' [BLANK_AUDIO]\n Add oat milk\n (silence) '))

srv.close()
rmSync(dir, { recursive: true, force: true })
console.log(`voiceSmoke: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
