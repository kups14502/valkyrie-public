import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AudioLines, Briefcase, Glasses, Building2, Gamepad2, HeadphoneOff, Headphones, House, Keyboard, Mic, MicOff, Play, ScanLine, SkipBack, SkipForward, Speaker,
  SunDim, Video, Volume1, Volume2, VolumeX,
} from 'lucide-react'
import { Press, Section, cx, toast } from '../kit/ui'
import { apiErrorText } from '../../lib/api'
import { fetchHotkeys, fetchSoundboard, playClip, pressHotkey, stopClips, type Clip, type HotkeyId, type HotkeyState } from '../../lib/hotkeysApi'
import './hotkeys.css'

// Dashboard > Hotkeys (/m/dashboard/hotkeys), on the iPad only: the iPad sits under
// the main monitor, so this is thor's keyboard as buttons. Each one runs the same
// action as its key (C:\Thor\scripts\thorkeys.ahk): thor's API agent hands the id
// to that script, which runs elevated, so a press reaches whatever window has
// focus on thor, elevated or not. A tap never moves focus on thor, so Screenshot
// acts on the window in front of Brendon. The mic key shows the real mute state
// (every mic muted, or one live), Output the default playback device, both polled
// while the tab is open. Discord's keys need its own keybinds (Toggle Mute F19,
// Toggle Deafen F20); Save clip is NVIDIA Instant Replay's save key. Mode flips the
// mouse and the keyboard between work and game profiles together; thor's agent runs it
// itself (C:\Thor\scripts\GameMode.psm1), so it works while THOR Keys is down. VR starts or quits
// SteamVR and moves thor's default playback and recording to the Frame (Loki) and back to the
// output used before and the Yeti (C:\Thor\scripts\VrMode.ps1, run by the agent; it polls faster while
// that runs).
//
// The soundboard row plays clips into thor's mic (an audio plug-in on the Yeti mixes
// them in, so apps keep the real mic and the voice gets no delay) and on thor's
// speakers. Clips are the files in thor's soundboard folder, by name.

type Key = { id: HotkeyId; label: string; icon: ReactElement; hint?: string }

const DISCORD: Key[] = [
  { id: 'discordmute', label: 'Mute', icon: <MicOff />, hint: 'Discord' },
  { id: 'discorddeafen', label: 'Deafen', icon: <HeadphoneOff />, hint: 'Discord' },
]

// thor names these (HotkeyState.labels); the generic names show until its first answer
const CLAUDE: Key[] = [
  { id: 'claude1', label: 'Claude 1', icon: <House /> },
  { id: 'claude2', label: 'Claude 2', icon: <Briefcase /> },
  { id: 'claude3', label: 'Claude 3', icon: <Building2 /> },
]

const SCREEN: Key[] = [
  { id: 'dim', label: 'Dim', icon: <SunDim /> },
  { id: 'shot', label: 'Screenshot', icon: <ScanLine />, hint: 'region' },
  { id: 'clip', label: 'Save clip', icon: <Video />, hint: 'last 5 min' },
]

const MEDIA: Key[] = [
  { id: 'prev', label: 'Previous', icon: <SkipBack /> },
  { id: 'play', label: 'Play / pause', icon: <Play /> },
  { id: 'next', label: 'Next', icon: <SkipForward /> },
]

const SOUND: Key[] = [
  { id: 'output', label: 'Output', icon: <Speaker /> },
  { id: 'voldown', label: 'Vol down', icon: <Volume1 /> },
  { id: 'volup', label: 'Vol up', icon: <Volume2 /> },
  { id: 'volmute', label: 'Sound off', icon: <VolumeX /> },
]

const secs = (s: number | null) => (s == null ? '' : s < 10 ? `${s.toFixed(1)} s` : `${Math.round(s)} s`)

export default function Hotkeys({ active }: { active: boolean }) {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['hotkeys'],
    queryFn: fetchHotkeys,
    refetchInterval: (query) => (document.hidden || !active ? false : query.state.data?.vr === 'starting' || query.state.data?.vr === 'stopping' ? 1_500 : 4_000),
  })
  const state: HotkeyState | undefined = q.data
  const down = q.isError && !q.data
  const off = down || (!!state && !state.ready)
  const [sent, setSent] = useState<string | null>(null)
  const flash = useRef(0)
  useEffect(() => () => window.clearTimeout(flash.current), [])

  const lit = (key: string) => {
    setSent(key)
    window.clearTimeout(flash.current)
    flash.current = window.setTimeout(() => setSent(null), 650)
  }

  // never gated on an earlier press, so volume taps in a row each land
  const press = async (k: Key) => {
    if (k.id === 'mode' || k.id === 'vr' ? down : off) return
    try {
      await pressHotkey(k.id)
      lit(k.id)
      // these change state; thor reports the new one as soon as the action runs
      if (k.id === 'mic' || k.id === 'dim' || k.id === 'output' || k.id === 'mode' || k.id === 'vr') window.setTimeout(() => void qc.invalidateQueries({ queryKey: ['hotkeys'] }), 300)
    } catch (err) {
      toast(apiErrorText(err, `${k.label}: thor is not answering`), { ms: 4000 })
    }
  }

  const muted = state?.mic === 'muted'
  const micWord = !state ? '--' : state.mic === 'muted' ? 'Mic muted' : state.mic === 'live' ? 'Mic live' : 'No mic found'
  const game = state?.mode === 'game'
  const modeWord = !state ? '--' : game ? 'Game mode' : state.mode === 'work' ? 'Work mode' : 'Mode unknown'
  const vr = state?.vr ?? null
  const vrBusy = vr === 'starting' || vr === 'stopping'
  const vrWord = !state ? '--' : vr === 'on' ? 'VR on' : vr === 'starting' ? 'Starting VR' : vr === 'stopping' ? 'Stopping VR' : 'VR off'

  const tile = (k: Key, extra?: string) => (
    <Press
      key={k.id}
      className="hk-key vl-btn-line"
      data-sent={sent === k.id || undefined}
      disabled={off}
      onPress={() => void press(k)}
    >
      <span className="hk-icon" aria-hidden>{k.icon}</span>
      <span className="hk-label">{k.label}</span>
      {(extra ?? k.hint) && <span className="hk-hint">{extra ?? k.hint}</span>}
    </Press>
  )

  const sound = (k: Key) => {
    if (k.id !== 'output') return tile(k)
    const headset = state?.output === 'Headset'
    return tile({ ...k, icon: headset ? <Headphones /> : <Speaker /> }, state?.output ?? (state ? 'other' : undefined))
  }

  return (
    <div className="vl-screen hk">
      <header className="hk-head">
        <h2>Thor</h2>
        <span className={cx('hk-status', off && 'vl-acc2')}>
          {down ? 'Thor is not answering' : state && !state.ready ? 'THOR Keys is not running on thor' : state ? 'Presses go to the window in focus' : '\u00a0'}
        </span>
      </header>

      <div className="hk-cols">
        <div className="hk-col">
          <div className="hk-pair">
            <section className="hk-sec">
              <Section icon={muted ? <MicOff size={14} strokeWidth={1.6} className="vl-icon vl-icon-acc2 vl-icon-glow" /> : <Mic size={14} strokeWidth={1.6} className="vl-icon vl-icon-fg vl-icon-glow" />}>Mic</Section>
              <Press
                className="hk-key hk-mic vl-btn-line"
                data-muted={muted || undefined}
                data-live={state?.mic === 'live' || undefined}
                data-sent={sent === 'mic' || undefined}
                aria-label={`${micWord}: toggle`}
                disabled={off}
                onPress={() => void press({ id: 'mic', label: 'Mic', icon: <Mic /> })}
              >
                <span className="hk-icon" aria-hidden>{muted ? <MicOff /> : <Mic />}</span>
                <span className="hk-label">{micWord}</span>
                <span className="hk-hint">{muted ? 'tap to go live' : state?.mic === 'live' ? 'tap to mute every mic' : ''}</span>
              </Press>
            </section>
            <section className="hk-sec">
              <Section icon={<Gamepad2 size={14} strokeWidth={1.6} className="vl-icon vl-icon-fg vl-icon-glow" />}>Mode</Section>
              <Press
                className="hk-key hk-mode vl-btn-line"
                data-game={game || undefined}
                data-sent={sent === 'mode' || undefined}
                aria-label={`${modeWord}: switch mouse and keyboard`}
                disabled={down}
                onPress={() => void press({ id: 'mode', label: 'Mode', icon: <Gamepad2 /> })}
              >
                <span className="hk-icon" aria-hidden>{game ? <Gamepad2 /> : <Keyboard />}</span>
                <span className="hk-label">{modeWord}</span>
                <span className="hk-hint">{game ? 'tap for work' : state?.mode === 'work' ? 'tap for game' : ''}</span>
              </Press>
            </section>
            <section className="hk-sec">
              <Section icon={<Glasses size={14} strokeWidth={1.6} className="vl-icon vl-icon-fg vl-icon-glow" />}>VR</Section>
              <Press
                className="hk-key hk-vr vl-btn-line"
                data-on={vr === 'on' || undefined}
                data-busy={vrBusy || undefined}
                data-sent={sent === 'vr' || undefined}
                aria-label={`${vrWord}: ${vr === 'on' ? 'quit SteamVR, audio back to thor' : 'start SteamVR, audio to Loki'}`}
                aria-busy={vrBusy || undefined}
                disabled={down || vrBusy}
                onPress={() => void press({ id: 'vr', label: 'VR', icon: <Glasses /> })}
              >
                <span className="hk-icon" aria-hidden><Glasses /></span>
                <span className="hk-label">{vrWord}</span>
                <span className="hk-hint">{vr === 'on' ? 'audio on Loki' : vrBusy ? 'switching audio' : vr === 'off' ? 'tap for Loki' : ''}</span>
              </Press>
            </section>
          </div>
          <section className="hk-sec">
            <Section icon={<Headphones size={14} strokeWidth={1.6} className="vl-icon vl-icon-fg vl-icon-glow" />}>Discord</Section>
            <div className="hk-grid hk-grid-2">{DISCORD.map((k) => tile(k))}</div>
          </section>
          <section className="hk-sec">
            <Section icon="newSession">New Claude</Section>
            <div className="hk-grid hk-grid-3">{CLAUDE.map((k) => tile({ ...k, label: state?.labels[k.id] ?? k.label }))}</div>
          </section>
        </div>
        <div className="hk-col">
          <section className="hk-sec">
            <Section icon="thor">Screen</Section>
            <div className="hk-grid hk-grid-3">
              {SCREEN.map((k) => tile(k, k.id === 'dim' ? (state?.dim ? `${state.dim}%` : 'off') : undefined))}
            </div>
          </section>
          <section className="hk-sec">
            <Section icon="music">Media</Section>
            <div className="hk-grid hk-grid-3">{MEDIA.map((k) => tile(k))}</div>
          </section>
          <section className="hk-sec">
            <Section icon={<Volume2 size={14} strokeWidth={1.6} className="vl-icon vl-icon-fg vl-icon-glow" />}>Sound</Section>
            <div className="hk-grid hk-grid-4">{SOUND.map(sound)}</div>
          </section>
        </div>
      </div>

      <SoundboardRow active={active} sent={sent} lit={lit} />
    </div>
  )
}

/** The clip keys, one per file in thor's soundboard folder, and Stop. */
function SoundboardRow({ active, sent, lit }: { active: boolean; sent: string | null; lit: (key: string) => void }) {
  const sb = useQuery({ queryKey: ['soundboard'], queryFn: fetchSoundboard, refetchInterval: () => (document.hidden || !active ? false : 10_000), retry: false })
  const clips: Clip[] = sb.data?.clips ?? []
  const down = sb.isError && !sb.data

  const play = async (c: Clip) => {
    try {
      await playClip(c.name)
      lit(`clip:${c.name}`)
    } catch (err) {
      toast(apiErrorText(err, `${c.name}: the soundboard is not answering`), { ms: 4000 })
    }
  }
  const stop = async () => {
    try {
      await stopClips()
    } catch (err) {
      toast(apiErrorText(err, 'Stop: the soundboard is not answering'), { ms: 4000 })
    }
  }

  const note = down
    ? apiErrorText(sb.error, 'The soundboard is not answering')
    : sb.data && !clips.length
      ? 'No clips yet: add audio files to C:\\Thor\\tools\\soundboard\\clips'
      : sb.data && !sb.data.micConnected
        ? 'No app has the mic open: only you hear clips'
        : null

  return (
    <section className="hk-sec hk-sb" aria-label="Soundboard">
      <Section
        icon={<AudioLines size={14} strokeWidth={1.6} className="vl-icon vl-icon-fg vl-icon-glow" />}
        action={clips.length > 0 && !down ? <Press className="vl-link hk-stop" onPress={() => void stop()}>Stop all</Press> : undefined}
      >
        Soundboard
      </Section>
      {note && <p className={cx('hk-note', down && 'vl-acc2')}>{note}</p>}
      {clips.length > 0 && !down && (
        <div className="hk-grid hk-grid-clips">
          {clips.map((c) => (
            <Press key={c.name} className="hk-key hk-clip vl-btn-line" data-sent={sent === `clip:${c.name}` || undefined} onPress={() => void play(c)}>
              <span className="hk-label">{c.name}</span>
              {c.seconds != null && <span className="hk-hint">{secs(c.seconds)}</span>}
            </Press>
          ))}
        </div>
      )}
    </section>
  )
}
