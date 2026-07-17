import { Router, raw } from 'express'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gigServer, GIG_ALLOWED } from '../routes/gigChat.js'
import { mediaTools } from './media.js'
import { opsTools } from './ops.js'

// The general assistant ("Jarvis mode"): one agent, three tool servers —
// gigs (shared with the gig agent), media (Radarr/Sonarr), ops (trading,
// system, services, lights, self-update). Exposed as an SSE chat endpoint
// plus STT/TTS proxies so the kiosk UI only ever talks to this backend.

const router = Router()

const MODEL = process.env.VALKYRIE_ASSISTANT_MODEL || 'claude-sonnet-5'
const NAME = process.env.VALKYRIE_ASSISTANT_NAME || 'Jarvis'
const WHISPER_URL = process.env.WHISPER_URL || 'http://127.0.0.1:8378'
const KOKORO_URL = process.env.KOKORO_URL || 'http://127.0.0.1:8379'
const KOKORO_VOICE = process.env.KOKORO_VOICE || 'bm_george'
const KOKORO_SPEED = Number(process.env.KOKORO_SPEED) || 1.0

const mediaServer = createSdkMcpServer({ name: 'media', version: '1.0.0', tools: mediaTools })
const opsServer = createSdkMcpServer({ name: 'ops', version: '1.0.0', tools: opsTools })
const ALLOWED = [
  ...GIG_ALLOWED,
  ...mediaTools.map((t) => `mcp__media__${t.name}`),
  ...opsTools.map((t) => `mcp__ops__${t.name}`),
]

// Tools whose results the UI renders as rich cards. The route emits the raw
// result JSON alongside the agent's prose so the model never has to recite
// tables aloud.
const CARD_KIND: Record<string, string> = {
  mcp__ops__trading_status: 'trading',
  mcp__ops__system_status: 'system',
  mcp__ops__service_health: 'services',
  mcp__ops__list_lights: 'lights',
  mcp__ops__update_valkyrie: 'update',
  mcp__media__search_media: 'media-results',
  mcp__media__add_media: 'media-added',
  mcp__media__media_queue: 'media-queue',
  mcp__gigs__list_gigs: 'gigs',
}

const SYSTEM_PROMPT = `You are ${NAME}, the resident AI of the home server "odin" — the house intelligence for Brendon's homelab. You run on a Jarvis-style touchscreen kiosk on odin itself, and sometimes on Brendon's phone or desktop (thor). Norse naming: odin = this server, thor = desktop PC, valkyrie = the dashboard app you live in, bifrost = the file share.

Your replies are SPOKEN ALOUD via TTS and shown as chat bubbles.
Style rules:
- Natural spoken English. 1–3 short sentences unless asked for detail. Confident, dry, lightly wry — classic JARVIS butler energy. Never sycophantic.
- No markdown, no bullet lists, no emojis, no URLs, no raw JSON, no id strings. Round numbers conversationally ("up about two percent", "a hundred and forty gigs free").
- The UI automatically renders rich cards for your tool results (portfolio, media matches, gig lists, download queue, system stats). Don't recite what the card shows — give the headline and the takeaway.

What you can do:
- Gigs (the gig log / task tracker): list, create, update, complete, delete via the gig tools. 'work' gigs mirror Autotask tickets — the ticket is the source of truth, a ~10-minute sync overwrites local status flips, and completing one here does NOT close the real ticket; warn before touching work gigs.
- Media: search_media then add_media to put movies (Radarr) or shows (Sonarr) into the pipeline — they download automatically and appear in Plex. Always search first; if results are ambiguous, ask which one (year helps). If it's already in the library, just say so. media_queue answers "is it done yet".
- Trading: trading_status reports the autonomous trade-bot (the broker cash account). You can NOT place or cancel trades — if asked, say the bot trades on its own and you only report.
- Server ops: system_status, service_health, restart_service (needs explicit confirmation — ask, then pass confirm=true), lights via list_lights/set_lights.
- Self-update: update_valkyrie with action 'check' anytime. For action 'backend', FIRST tell the user you'll go quiet for about a minute while the backend rebuilds and restarts, THEN call the tool. Action 'apps' ships the desktop/mobile release pipeline in the background.

General rules:
- Call list_gigs before referencing or changing gigs; never guess ids. Same for search_media before add_media.
- Destructive actions (delete_gig, restart_service) need explicit user confirmation in conversation first.
- If a tool fails, say plainly what failed and the most likely fix. Never invent data.
- Today is {{DATE}}.`

router.post('/assistant/chat', async (req, res) => {
  const { message, sessionId } = (req.body ?? {}) as { message?: string; sessionId?: string }
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message required' })
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()
  const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`)

  const ac = new AbortController()
  // The response 'close' (not the request's) is the real client-disconnect
  // signal — see gigChat.ts for the why.
  res.on('close', () => { if (!res.writableEnded) ac.abort() })

  try {
    const q = query({
      prompt: message.slice(0, 4000),
      options: {
        model: MODEL,
        systemPrompt: SYSTEM_PROMPT.replace('{{DATE}}', new Date().toDateString()),
        mcpServers: { gigs: gigServer, media: mediaServer, ops: opsServer },
        allowedTools: ALLOWED,
        disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit', 'TodoWrite', 'KillShell', 'BashOutput'],
        maxTurns: 24,
        cwd: process.env.VALKYRIE_ROOT ? path.join(process.env.VALKYRIE_ROOT, 'backend') : '/home/brendon/valkyrie/backend',
        abortController: ac,
        ...(sessionId ? { resume: sessionId } : {}),
      },
    })

    let newSessionId: string | null = null
    // tool_use id -> tool name, so tool results (which arrive as user
    // messages) can be matched back to the tool that produced them.
    const toolNames = new Map<string, string>()

    for await (const msg of q) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        newSessionId = msg.session_id
      } else if (msg.type === 'assistant') {
        for (const block of msg.message.content ?? []) {
          if (block.type === 'text' && block.text) {
            send({ type: 'text', text: block.text })
          } else if (block.type === 'tool_use' && String(block.name).startsWith('mcp__')) {
            toolNames.set(String(block.id), String(block.name))
            send({ type: 'action', name: String(block.name).replace(/^mcp__[a-z]+__/, '') })
          }
        }
      } else if (msg.type === 'user') {
        const content = (msg as any).message?.content
        if (!Array.isArray(content)) continue
        for (const block of content) {
          if (block?.type !== 'tool_result' || !block.tool_use_id) continue
          const toolName = toolNames.get(String(block.tool_use_id))
          const kind = toolName ? CARD_KIND[toolName] : undefined
          if (!kind) continue
          const text = Array.isArray(block.content)
            ? block.content.find((c: any) => c?.type === 'text')?.text
            : typeof block.content === 'string' ? block.content : undefined
          if (!text) continue
          try {
            const data = JSON.parse(text)
            if (!data || data.error) continue
            send({ type: 'card', kind, data })
          } catch { /* non-JSON tool output: no card */ }
        }
      } else if (msg.type === 'result') {
        send({ type: 'done', sessionId: newSessionId ?? sessionId ?? null, isError: msg.subtype !== 'success' })
      }
    }
  } catch (err) {
    if (!ac.signal.aborted) {
      console.error('[assistant-chat] failed:', err)
      send({ type: 'error', message: (err as Error).message || 'agent failed' })
    }
  } finally {
    res.end()
  }
})

// --- Voice: speech-to-text ---------------------------------------------------
// Browser posts whatever MediaRecorder produced (webm/ogg opus). ffmpeg
// normalizes to 16 kHz mono wav on disk, whisper-server transcribes it.

function ffmpegToWav(input: Buffer, inPath: string, outPath: string): Promise<void> {
  return writeFile(inPath, input).then(() => new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', inPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', outPath])
    let err = ''
    ff.stderr.on('data', (d) => { err += d })
    ff.on('error', reject)
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${err.slice(0, 300)}`))))
  }))
}

router.post('/assistant/stt', raw({ type: () => true, limit: '25mb' }), async (req, res) => {
  const body = req.body as Buffer
  if (!body || !Buffer.isBuffer(body) || body.length < 100) {
    return res.status(400).json({ error: 'audio body required' })
  }
  const id = randomUUID()
  const inPath = path.join(tmpdir(), `stt-${id}.in`)
  const wavPath = path.join(tmpdir(), `stt-${id}.wav`)
  try {
    await ffmpegToWav(body, inPath, wavPath)
    const form = new FormData()
    const wav = await readFile(wavPath)
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav')
    form.append('response_format', 'json')
    form.append('temperature', '0')
    const r = await fetch(`${WHISPER_URL}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(30_000) })
    if (!r.ok) throw new Error(`whisper-server HTTP ${r.status}`)
    const out = await r.json() as { text?: string }
    const text = String(out.text ?? '').trim()
    res.json({ text })
  } catch (err) {
    console.error('[assistant-stt] failed:', err)
    res.status(502).json({ error: (err as Error).message || 'transcription failed' })
  } finally {
    void unlink(inPath).catch(() => {})
    void unlink(wavPath).catch(() => {})
  }
})

// --- Voice: text-to-speech ---------------------------------------------------

router.post('/assistant/tts', async (req, res) => {
  const { text, voice, speed } = (req.body ?? {}) as { text?: string; voice?: string; speed?: number }
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text required' })
  }
  try {
    const r = await fetch(`${KOKORO_URL}/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: text.slice(0, 2000),
        voice: typeof voice === 'string' && /^[a-z]{2}_[a-z]+$/.test(voice) ? voice : KOKORO_VOICE,
        speed: typeof speed === 'number' && speed >= 0.5 && speed <= 2 ? speed : KOKORO_SPEED,
      }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!r.ok) throw new Error(`kokoro HTTP ${r.status}`)
    res.setHeader('Content-Type', 'audio/wav')
    res.setHeader('Cache-Control', 'no-store')
    res.send(Buffer.from(await r.arrayBuffer()))
  } catch (err) {
    console.error('[assistant-tts] failed:', err)
    res.status(502).json({ error: (err as Error).message || 'speech synthesis failed' })
  }
})

// --- Config/health for the kiosk UI -----------------------------------------

router.get('/assistant/config', async (_req, res) => {
  const probe = async (url: string) => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      return r.ok || r.status === 404 // whisper-server has no root route; any response = alive
    } catch { return false }
  }
  const [stt, tts] = await Promise.all([probe(WHISPER_URL), probe(`${KOKORO_URL}/healthz`)])
  res.json({ name: NAME, model: MODEL, voice: KOKORO_VOICE, stt, tts })
})

export default router
