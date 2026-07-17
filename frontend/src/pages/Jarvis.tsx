import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Keyboard, Mic, RotateCcw, Send, Volume2, VolumeX, X } from 'lucide-react'
import { fetchGigs, fetchLauncher, fetchSystem, fetchTrading } from '../lib/api'
import { fetchAssistantConfig, streamAssistant, synthesize, type AssistantEvent } from '../lib/assistant'
import { useVoice } from '../lib/useVoice'
import { AssistantCardView, type AssistantCard } from '../components/AssistantCards'

// Jarvis mode: fullscreen voice+touch assistant for the odin touchscreen
// (an Echo-Show-style ambient HUD that wakes into a chat on tap), also usable
// from the phone/desktop over the normal authed origin. Route: /jarvis.
// The kiosk build is served by the backend at /kiosk/jarvis (see index.ts).

type ChatMsg = {
  role: 'user' | 'assistant' | 'note'
  text: string
  actions?: string[]
  cards?: AssistantCard[]
}

const SESSION_KEY = 'valkyrie-assistant-session'
const MUTE_KEY = 'valkyrie-assistant-muted'
const IDLE_AFTER_MS = 90_000

const ACTION_LABEL: Record<string, string> = {
  list_gigs: 'reading gig log',
  create_gig: 'adding gig',
  update_gig: 'updating gig',
  add_objectives: 'adding objectives',
  delete_gig: 'deleting gig',
  add_link: 'linking',
  search_media: 'searching library',
  add_media: 'adding to library',
  media_queue: 'checking downloads',
  trading_status: 'checking the portfolio',
  system_status: 'checking vitals',
  service_health: 'pinging services',
  restart_service: 'restarting service',
  list_lights: 'reading lights',
  set_lights: 'switching lights',
  update_valkyrie: 'running update',
}

// TTS input: prose only. The model is told not to emit markdown, but strip
// the common offenders anyway so a slip never gets read out loud.
const cleanForSpeech = (text: string) =>
  text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>|]/g, ' ')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()

function useClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(t)
  }, [])
  return now
}

const usd0 = (n: unknown) =>
  typeof n === 'number' && Number.isFinite(n)
    ? n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
    : '—'

export default function Jarvis() {
  const queryClient = useQueryClient()
  const [mode, setMode] = useState<'idle' | 'chat'>('idle')
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [busy, setBusy] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [muted, setMuted] = useState(() => localStorage.getItem(MUTE_KEY) === '1')
  const [showKeyboard, setShowKeyboard] = useState(false)
  const [input, setInput] = useState('')

  const sessionRef = useRef<string | null>(sessionStorage.getItem(SESSION_KEY))
  const scrollRef = useRef<HTMLDivElement>(null)
  const followUpArmed = useRef(false)
  const mutedRef = useRef(muted)
  mutedRef.current = muted

  const { data: config } = useQuery({ queryKey: ['assistant-config'], queryFn: fetchAssistantConfig, refetchInterval: 60_000 })
  const name = (config?.name ?? 'Jarvis').toUpperCase()

  // ---- speech output queue --------------------------------------------------
  const speech = useRef<{ queue: Promise<Blob | null>[]; playing: HTMLAudioElement | null; running: boolean }>({
    queue: [], playing: null, running: false,
  })

  const stopSpeech = useCallback(() => {
    const s = speech.current
    s.queue.length = 0
    if (s.playing) { try { s.playing.pause() } catch { /* fine */ } s.playing = null }
  }, [])

  const runPlayer = useCallback(async () => {
    const s = speech.current
    if (s.running) return
    s.running = true
    setSpeaking(true)
    while (s.queue.length > 0) {
      const blob = await s.queue.shift()!
      if (!blob) continue
      await new Promise<void>((resolve) => {
        const a = new Audio(URL.createObjectURL(blob))
        s.playing = a
        const done = () => { URL.revokeObjectURL(a.src); if (s.playing === a) s.playing = null; resolve() }
        a.onended = done
        a.onerror = done
        a.onpause = () => { if (!a.ended) done() }
        a.play().catch(done)
      })
    }
    s.running = false
    setSpeaking(false)
  }, [])

  const enqueueSpeech = useCallback((text: string) => {
    if (mutedRef.current) return
    const clean = cleanForSpeech(text)
    if (!clean) return
    speech.current.queue.push(synthesize(clean).catch(() => null))
    void runPlayer()
  }, [runPlayer])

  // ---- chat -----------------------------------------------------------------
  const appendToLast = useCallback((fn: (last: ChatMsg) => ChatMsg) => {
    setMessages((m) => m.map((msg, i) => (i === m.length - 1 ? fn(msg) : msg)))
  }, [])

  const note = useCallback((text: string) => {
    setMessages((m) => [...m, { role: 'note', text }])
  }, [])

  const sendMessage = useCallback(async (text: string, viaVoice: boolean) => {
    const trimmed = text.trim()
    if (!trimmed) return
    setBusy(true)
    setMessages((m) => [...m, { role: 'user', text: trimmed }, { role: 'assistant', text: '' }])

    let hadError = false
    try {
      await streamAssistant({ message: trimmed, sessionId: sessionRef.current }, (ev: AssistantEvent) => {
        if (ev.type === 'text' && ev.text) {
          appendToLast((last) => ({ ...last, text: last.text ? `${last.text}\n${ev.text}` : ev.text }))
          enqueueSpeech(ev.text)
        } else if (ev.type === 'action' && ev.name) {
          appendToLast((last) => ({ ...last, actions: [...(last.actions ?? []), ACTION_LABEL[ev.name] ?? ev.name] }))
          if (ev.name.includes('gig')) void queryClient.invalidateQueries({ queryKey: ['gigs'] })
        } else if (ev.type === 'card') {
          appendToLast((last) => ({ ...last, cards: [...(last.cards ?? []), { kind: ev.kind, data: ev.data }] }))
        } else if (ev.type === 'done') {
          if (ev.sessionId) {
            sessionRef.current = ev.sessionId
            sessionStorage.setItem(SESSION_KEY, ev.sessionId)
          }
          hadError = Boolean(ev.isError)
        } else if (ev.type === 'error') {
          hadError = true
          appendToLast((last) => ({ ...last, text: last.text || `! ${ev.message ?? 'assistant failed'}` }))
        }
      })
    } catch (err) {
      hadError = true
      appendToLast((last) => ({ ...last, text: last.text || `! ${(err as Error).message}` }))
    } finally {
      setBusy(false)
      // Hands-free follow-up: after a spoken exchange finishes (reply audio
      // included), the mic re-arms once; silence just lets it lapse.
      followUpArmed.current = viaVoice && !hadError
    }
  }, [appendToLast, enqueueSpeech, queryClient])

  // ---- voice input ----------------------------------------------------------
  const voice = useVoice({
    onTranscript: (text) => { void sendMessage(text, true) },
    onNoSpeech: () => { /* mic lapses quietly */ },
    onError: (message) => note(`! ${message}`),
  })
  const voiceStateRef = useRef(voice.state)
  voiceStateRef.current = voice.state

  const micTap = useCallback(() => {
    if (voice.state === 'listening') { voice.stop(); return }
    if (voice.state === 'transcribing' || busy) return
    if (speaking) stopSpeech() // barge-in
    followUpArmed.current = false
    void voice.start()
  }, [voice, busy, speaking, stopSpeech])

  useEffect(() => {
    if (!busy && !speaking && mode === 'chat' && followUpArmed.current && voiceStateRef.current === 'idle') {
      followUpArmed.current = false
      void voice.start()
    }
  }, [busy, speaking, mode, voice])

  // ---- ambient behaviors ----------------------------------------------------
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, mode])

  // Return to the idle HUD after a quiet period.
  useEffect(() => {
    if (mode !== 'chat') return
    const t = window.setTimeout(() => {
      if (!busy && !speaking && voiceStateRef.current === 'idle') setMode('idle')
    }, IDLE_AFTER_MS)
    return () => window.clearTimeout(t)
  }, [mode, messages, busy, speaking, voice.state])

  // Keep the screen awake while in an active conversation.
  useEffect(() => {
    if (mode !== 'chat') return
    let lock: { release?: () => Promise<void> } | null = null
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release?: () => Promise<void> }> } }
    void nav.wakeLock?.request('screen').then((l) => { lock = l }).catch(() => {})
    return () => { void lock?.release?.().catch(() => {}) }
  }, [mode])

  const wake = useCallback(() => {
    setMode('chat')
    followUpArmed.current = false
    if (voiceStateRef.current === 'idle' && !busy) void voice.start()
  }, [voice, busy])

  const resetConversation = useCallback(() => {
    stopSpeech()
    setMessages([])
    sessionRef.current = null
    sessionStorage.removeItem(SESSION_KEY)
  }, [stopSpeech])

  const status = voice.state === 'listening' ? 'listening'
    : voice.state === 'transcribing' ? 'processing speech'
    : busy ? 'thinking'
    : speaking ? 'speaking'
    : 'ready'

  if (mode === 'idle') return <IdleHud name={name} onWake={wake} />

  return (
    <div className="flex h-dvh w-full flex-col bg-[var(--color-bg)] text-[var(--color-text)]">
      {/* header */}
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-4 py-2.5">
        <span className="text-sm font-bold tracking-[0.3em] text-[var(--color-accent)]" style={{ textShadow: '0 0 10px var(--color-accent)' }}>
          {name}<span className="opacity-40">//</span>ODIN
        </span>
        <span className="text-[10px] uppercase tracking-[0.2em] text-[var(--color-text-faint)]">{status}<span className="cursor-blink">_</span></span>
        <div className="ml-auto flex items-center gap-1">
          <button type="button" aria-label={muted ? 'Unmute' : 'Mute'} onClick={() => { const v = !muted; setMuted(v); localStorage.setItem(MUTE_KEY, v ? '1' : '0'); if (v) stopSpeech() }} className="p-2.5 text-[var(--color-text-dim)] hover:text-[var(--color-accent)]">
            {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
          </button>
          <button type="button" aria-label="Toggle keyboard" onClick={() => setShowKeyboard((v) => !v)} className={`p-2.5 hover:text-[var(--color-accent)] ${showKeyboard ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-dim)]'}`}>
            <Keyboard size={18} />
          </button>
          <button type="button" aria-label="New conversation" onClick={resetConversation} className="p-2.5 text-[var(--color-text-dim)] hover:text-[var(--color-accent)]">
            <RotateCcw size={18} />
          </button>
          <button type="button" aria-label="Back to clock" onClick={() => { stopSpeech(); setMode('idle') }} className="p-2.5 text-[var(--color-text-dim)] hover:text-[var(--color-danger)]">
            <X size={18} />
          </button>
        </div>
      </header>

      {/* conversation */}
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-8">
        {messages.length === 0 && (
          <div className="mt-10 text-center text-sm leading-relaxed text-[var(--color-text-faint)]">
            &gt; ask about the server, the portfolio, or the gig log
            <br />&gt; "add the movie heat" · "how are the trades" · "is plex up"
            <br />&gt; "update valkyrie" · "lights off"
          </div>
        )}
        {messages.map((m, i) => (
          m.role === 'note' ? (
            <div key={i} className="text-center text-xs text-[var(--color-warning)]">{m.text}</div>
          ) : m.role === 'user' ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[80%] border border-[var(--color-accent-2)]/40 bg-[rgba(255,229,0,0.05)] px-3.5 py-2.5 text-base text-[var(--color-accent-2)]">
                {m.text}
              </div>
            </div>
          ) : (
            <div key={i} className="flex justify-start">
              <div className="max-w-[92%] space-y-2 sm:max-w-[80%]">
                {m.actions?.map((a, j) => (
                  <div key={j} className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-text-faint)]">⟳ {a}</div>
                ))}
                {(m.text || (busy && i === messages.length - 1)) && (
                  <div className="border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-2.5 text-base leading-relaxed">
                    <span className="whitespace-pre-wrap">{m.text}</span>
                    {busy && i === messages.length - 1 && <span className="cursor-blink">_</span>}
                  </div>
                )}
                {m.cards?.map((c, j) => <AssistantCardView key={j} card={c} />)}
              </div>
            </div>
          )
        ))}
      </div>

      {/* mic + optional keyboard */}
      <div className="shrink-0 border-t border-[var(--color-border)] px-4 pb-4 pt-3">
        {showKeyboard && (
          <form
            className="mx-auto mb-3 flex w-full max-w-2xl items-center gap-2"
            onSubmit={(e) => { e.preventDefault(); const t = input; setInput(''); void sendMessage(t, false) }}
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={busy ? 'working…' : `message ${name.toLowerCase()}…`}
              disabled={busy}
              className="min-w-0 flex-1 border border-[var(--color-border)] bg-transparent px-3 py-2.5 text-base outline-none placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-border-strong)] disabled:opacity-50"
            />
            <button type="submit" disabled={busy || !input.trim()} aria-label="Send" className="border border-[var(--color-accent)]/60 p-2.5 text-[var(--color-accent)] disabled:opacity-40">
              <Send size={18} />
            </button>
          </form>
        )}
        <div className="flex flex-col items-center gap-1.5">
          <button
            type="button"
            onClick={micTap}
            aria-label="Talk"
            disabled={config ? !config.stt : false}
            className="relative flex h-20 w-20 items-center justify-center rounded-full border transition disabled:opacity-30"
            style={{
              borderColor: voice.state === 'listening' ? 'var(--color-accent)' : 'var(--color-border-strong)',
              background: voice.state === 'listening' ? 'rgba(0,255,65,0.10)' : 'rgba(255,255,255,0.02)',
              boxShadow: voice.state === 'listening'
                ? `0 0 ${16 + voice.level * 40}px rgba(var(--color-accent-rgb),${0.35 + voice.level * 0.5})`
                : '0 0 14px rgba(var(--color-accent-rgb),0.15)',
              transform: voice.state === 'listening' ? `scale(${1 + voice.level * 0.12})` : undefined,
            }}
          >
            <Mic size={30} className={voice.state === 'listening' ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-dim)]'} />
          </button>
          <div className="text-[10px] uppercase tracking-[0.22em] text-[var(--color-text-faint)]">
            {config && !config.stt ? 'voice offline — use keyboard' :
              voice.state === 'listening' ? 'tap when done' :
              speaking ? 'tap to interrupt' : 'tap to talk'}
          </div>
        </div>
      </div>
    </div>
  )
}

// ---- ambient idle screen ----------------------------------------------------

function IdleHud({ name, onWake }: { name: string; onWake: () => void }) {
  const now = useClock()
  const { data: system } = useQuery({ queryKey: ['system'], queryFn: fetchSystem, refetchInterval: 15_000 })
  const { data: trading } = useQuery({ queryKey: ['trading'], queryFn: fetchTrading, refetchInterval: 60_000 })
  const { data: gigs } = useQuery({ queryKey: ['gigs'], queryFn: fetchGigs, refetchInterval: 60_000 })
  const { data: launcher } = useQuery({ queryKey: ['launcher'], queryFn: fetchLauncher, refetchInterval: 120_000 })

  const time = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
  const [clock, meridiem] = time.split(' ')
  const date = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
  const activeGigs = (gigs ?? []).filter((g) => g.status === 'active').length
  const down = (launcher ?? []).filter((s) => s.health === 'down').length

  return (
    <button type="button" onClick={onWake} className="relative flex h-dvh w-full cursor-pointer flex-col items-center justify-center bg-[var(--color-bg)] text-[var(--color-text)]">
      <div className="absolute left-5 top-4 text-xs font-bold tracking-[0.35em] text-[var(--color-accent)]" style={{ textShadow: '0 0 10px var(--color-accent)' }}>
        {name}<span className="opacity-40">//</span>ODIN<span className="cursor-blink">_</span>
      </div>

      <div className="flex items-baseline gap-3">
        <span className="text-[clamp(72px,18vw,220px)] font-bold leading-none tracking-tight" style={{ textShadow: '0 0 30px rgba(var(--color-accent-rgb),0.35)' }}>
          {clock}
        </span>
        {meridiem && <span className="text-[clamp(18px,3vw,40px)] text-[var(--color-text-dim)]">{meridiem}</span>}
      </div>
      <div className="mt-2 text-[clamp(13px,1.6vw,20px)] uppercase tracking-[0.35em] text-[var(--color-text-dim)]">{date}</div>

      <div className="mt-8 animate-pulse text-[11px] uppercase tracking-[0.3em] text-[var(--color-text-faint)]">tap to talk</div>

      <div className="absolute inset-x-0 bottom-0 grid grid-cols-2 gap-px border-t border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-4">
        <HudTile label="equity" value={usd0(trading?.portfolio?.equity)} sub={trading?.marketRegime ?? ''} />
        <HudTile
          label="cpu / mem"
          value={system ? `${system.cpu.usage.toFixed(0)}% · ${system.memory.percent.toFixed(0)}%` : '—'}
          sub={system ? `disk ${system.disk.percent.toFixed(0)}%` : ''}
        />
        <HudTile label="gigs active" value={String(activeGigs || '—')} sub="" />
        <HudTile label="services" value={down === 0 ? 'all up' : `${down} down`} alert={down > 0} sub="" />
      </div>
    </button>
  )
}

function HudTile({ label, value, sub, alert }: { label: string; value: string; sub: string; alert?: boolean }) {
  return (
    <div className="bg-[var(--color-bg)] px-4 py-3 text-left">
      <div className="text-[9px] uppercase tracking-[0.24em] text-[var(--color-text-faint)]">{label}</div>
      <div className={`mt-0.5 font-mono text-lg ${alert ? 'text-[var(--color-danger)]' : 'text-[var(--color-text)]'}`}>{value}</div>
      {sub && <div className="truncate text-[10px] text-[var(--color-text-faint)]">{sub}</div>}
    </div>
  )
}
