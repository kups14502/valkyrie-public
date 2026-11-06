import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Briefcase, Building2, ClipboardPaste, House, Mic, MicOff, Play, ScanLine, SkipBack, SkipForward, SunDim, Volume1, Volume2, VolumeX,
} from 'lucide-react'
import { Press, Section, cx, toast } from '../kit/ui'
import { apiErrorText } from '../../lib/api'
import { fetchHotkeys, pressHotkey, type HotkeyId, type HotkeyState } from '../../lib/hotkeysApi'
import './hotkeys.css'

// Dashboard > Hotkeys (/m/dashboard/hotkeys), on the iPad only: the iPad sits under
// the main monitor, so this is thor's keyboard as buttons. Each one runs the same
// action as its key (C:\Thor\scripts\thorkeys.ahk): thor's API agent hands the id
// to that script, which runs elevated, so a press reaches whatever window has
// focus on thor, elevated or not. A tap never moves focus on thor, so Paste and
// Screenshot act on the window in front of Brendon. The mic key shows the real
// mute state (every mic muted, or one live), polled while the tab is open.

type Key = { id: HotkeyId; label: string; icon: ReactElement; hint?: string }

// thor names these (HotkeyState.labels); the generic names show until its first answer
const CLAUDE: Key[] = [
  { id: 'claude1', label: 'Claude 1', icon: <House /> },
  { id: 'claude2', label: 'Claude 2', icon: <Briefcase /> },
  { id: 'claude3', label: 'Claude 3', icon: <Building2 /> },
]

const SCREEN: Key[] = [
  { id: 'dim', label: 'Dim', icon: <SunDim /> },
  { id: 'shot', label: 'Screenshot', icon: <ScanLine />, hint: 'region' },
  { id: 'paste', label: 'Paste plain', icon: <ClipboardPaste /> },
]

const MEDIA: Key[] = [
  { id: 'prev', label: 'Previous', icon: <SkipBack /> },
  { id: 'play', label: 'Play / pause', icon: <Play /> },
  { id: 'next', label: 'Next', icon: <SkipForward /> },
  { id: 'voldown', label: 'Volume down', icon: <Volume1 /> },
  { id: 'volup', label: 'Volume up', icon: <Volume2 /> },
  { id: 'volmute', label: 'Sound off', icon: <VolumeX /> },
]

export default function Hotkeys({ active }: { active: boolean }) {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['hotkeys'],
    queryFn: fetchHotkeys,
    refetchInterval: () => (document.hidden || !active ? false : 4_000),
  })
  const state: HotkeyState | undefined = q.data
  const down = q.isError && !q.data
  const off = down || (!!state && !state.ready)
  const [sent, setSent] = useState<HotkeyId | null>(null)
  const flash = useRef(0)
  useEffect(() => () => window.clearTimeout(flash.current), [])

  // never gated on an earlier press, so volume taps in a row each land
  const press = async (k: Key) => {
    if (off) return
    try {
      await pressHotkey(k.id)
      setSent(k.id)
      window.clearTimeout(flash.current)
      flash.current = window.setTimeout(() => setSent(null), 650)
      // the mic and the dim change state; thorkeys.ahk rewrites it as soon as the action runs
      if (k.id === 'mic' || k.id === 'dim') window.setTimeout(() => void qc.invalidateQueries({ queryKey: ['hotkeys'] }), 300)
    } catch (err) {
      toast(apiErrorText(err, `${k.label}: thor is not answering`), { ms: 4000 })
    }
  }

  const muted = state?.mic === 'muted'
  const micWord = !state ? '--' : state.mic === 'muted' ? 'Mic muted' : state.mic === 'live' ? 'Mic live' : 'No mic found'

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
        </div>
      </div>
    </div>
  )
}
