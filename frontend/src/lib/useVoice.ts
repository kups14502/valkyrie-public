import { useCallback, useEffect, useRef, useState } from 'react'
import { transcribe } from './assistant'

// Push-to-talk recorder with silence auto-stop. Tap starts capture; recording
// ends when the speaker goes quiet for SILENCE_MS (after having spoken), when
// MAX_MS elapses, when nothing is heard for NOSPEECH_MS, or on manual stop.
// The blob goes to /api/assistant/stt and the transcript comes back through
// onTranscript.

const START_RMS = 0.02 // above this = speech began
const STOP_RMS = 0.012 // below this = silence
const SILENCE_MS = 1400
const NOSPEECH_MS = 6000
const MAX_MS = 15000
const POLL_MS = 100

export type VoiceState = 'idle' | 'listening' | 'transcribing'

const pickMime = () => {
  if (typeof MediaRecorder === 'undefined') return null
  for (const m of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported(m)) return m
  }
  return null
}

export function useVoice(handlers: {
  onTranscript: (text: string) => void
  onNoSpeech: () => void
  onError: (message: string) => void
}) {
  const [state, setState] = useState<VoiceState>('idle')
  const [level, setLevel] = useState(0) // 0..1 live input level for the UI ring
  const h = useRef(handlers)
  h.current = handlers

  const rec = useRef<{
    recorder: MediaRecorder
    stream: MediaStream
    ctx: AudioContext
    timer: number
    chunks: Blob[]
    cancelled: boolean
    spoke: boolean
  } | null>(null)

  const teardown = useCallback(() => {
    const r = rec.current
    if (!r) return
    rec.current = null
    window.clearInterval(r.timer)
    try { if (r.recorder.state !== 'inactive') r.recorder.stop() } catch { /* already stopped */ }
    r.stream.getTracks().forEach((t) => t.stop())
    void r.ctx.close().catch(() => {})
    setLevel(0)
  }, [])

  const stop = useCallback((opts?: { cancel?: boolean }) => {
    const r = rec.current
    if (!r) return
    r.cancelled = Boolean(opts?.cancel) || !r.spoke
    try { if (r.recorder.state !== 'inactive') r.recorder.stop() } catch { /* fine */ }
  }, [])

  const start = useCallback(async () => {
    if (rec.current) return
    const mime = pickMime()
    if (!mime) { h.current.onError('recording not supported in this browser'); return }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    } catch {
      h.current.onError('microphone unavailable — check permissions')
      return
    }

    const ctx = new AudioContext()
    // Follow-up listens start without a fresh user gesture; make sure the
    // context isn't sitting suspended (VAD would read pure silence).
    void ctx.resume().catch(() => {})
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    ctx.createMediaStreamSource(stream).connect(analyser)
    const samples = new Float32Array(analyser.fftSize)

    const recorder = new MediaRecorder(stream, { mimeType: mime })
    const entry = { recorder, stream, ctx, timer: 0, chunks: [] as Blob[], cancelled: false, spoke: false }
    rec.current = entry

    const startedAt = Date.now()
    let lastVoice = 0

    entry.timer = window.setInterval(() => {
      analyser.getFloatTimeDomainData(samples)
      let sum = 0
      for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
      const rms = Math.sqrt(sum / samples.length)
      setLevel(Math.min(1, rms / 0.15))
      const now = Date.now()
      if (rms > START_RMS) { entry.spoke = true; lastVoice = now }
      const elapsed = now - startedAt
      if (
        elapsed > MAX_MS ||
        (entry.spoke && rms < STOP_RMS && now - lastVoice > SILENCE_MS) ||
        (!entry.spoke && elapsed > NOSPEECH_MS)
      ) stop()
    }, POLL_MS)

    recorder.ondataavailable = (e) => { if (e.data.size > 0) entry.chunks.push(e.data) }
    recorder.onstop = () => {
      const { chunks, cancelled } = entry
      teardown()
      if (cancelled || chunks.length === 0) {
        setState('idle')
        h.current.onNoSpeech()
        return
      }
      setState('transcribing')
      void transcribe(new Blob(chunks, { type: mime }))
        .then((text) => {
          setState('idle')
          if (text) h.current.onTranscript(text)
          else h.current.onNoSpeech()
        })
        .catch((err: Error) => {
          setState('idle')
          h.current.onError(err.message || 'transcription failed')
        })
    }

    recorder.start(250)
    setState('listening')
  }, [stop, teardown])

  useEffect(() => () => teardown(), [teardown])

  return { state, level, start, stop }
}
