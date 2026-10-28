import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { StatusStrip, desktopWindow } from '../kit/shell'
import { Button, DotFloor, IconButton, Press, Segmented, ToastHost, cx, toast } from '../kit/ui'
import { Icon } from '../kit/icons'
import { useTick } from '../kit/data'
import { applyPalette, useFont, useStoredMode } from '../kit/theme'
import { canDetach, openDetached, setDetachedTitle } from '../kit/windows'
import { apiErrorText } from '../../lib/api'
import { copyText } from '../../lib/clipboard'
import {
  askCall, dismissCallCard, fetchCallState, startCall, stopCall,
  type CallCard, type CallLine, type CallLive, type CallState,
} from '../../lib/callApi'
import './call.css'

// AI > Call, and the same page in a window of its own (/m/w/call). thor hears
// the call (what it plays: the other side of a Teams, Zoom or Discord call)
// and Brendon's mic, writes both down with Whisper on its own GPU, and Claude
// turns what the caller says into cards: what to answer, what to check, the
// client fact from their records. Cards come newest first; the transcript runs
// beside them (under them on a phone), and a box at the top asks Claude
// something directly.
//
// Everything lives on thor while the call runs (thor's call-assist service,
// through odin's /api/call). With Recording on, thor also records the screen
// the call is on. "End" drops the transcript and the recording; "Save and end"
// keeps the transcript in the notes and files the video on odin, in a folder
// named after the client.

type Vars = CSSProperties & Record<`--${string}`, string | number>
const iv = (i: number): Vars => ({ '--i': i })
const errText = (e: unknown) => apiErrorText(e, (e as Error | null)?.message || 'no reply')
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
// New York time, the way every Valkyrie time reads
const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })
const elapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}
const AREA_KEY = 'v2.call.area'
const REC_KEY = 'v2.call.record'
/** "<Area>\\<client>\\2026-10-28 1432 call.mp4" out of the full path on odin */
const shortVideo = (p: string) => p.split(/call-recordings[\\/]/i)[1] ?? p

/** thor's call state, kept current by a long poll while `on`. Lines collect by number across polls. */
function useCallState(on: boolean) {
  const [state, setState] = useState<CallState | null>(null)
  const [lines, setLines] = useState<CallLine[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!on) return
    const ac = new AbortController()
    let rev = 0
    let after = 0
    let callId: string | null | undefined
    let fails = 0
    void (async () => {
      while (!ac.signal.aborted) {
        try {
          const s = await fetchCallState(rev, after, rev ? 25 : 0, ac.signal)
          if (ac.signal.aborted) return
          fails = 0
          setError(null)
          const id = s.call?.id ?? null
          if (id !== callId) {
            // another call: its lines number from 1, so ask again from the start
            const first = callId === undefined
            callId = id
            setLines([])
            if (id && !first && after) { after = 0; rev = 0; continue }
            after = 0
          }
          if (s.call?.lines.length) {
            const fresh = s.call.lines
            after = Math.max(after, fresh[fresh.length - 1].n)
            setLines((prev) => {
              const byN = new Map(prev.map((l) => [l.n, l]))
              for (const l of fresh) byN.set(l.n, l)
              return [...byN.values()].sort((a, b) => a.n - b.n).slice(-1500)
            })
          }
          rev = s.rev
          setState(s)
        } catch (e) {
          if (ac.signal.aborted) return
          fails++
          setError(errText(e))
          await sleep(Math.min(2000 * fails, 10_000))
        }
      }
    })()
    return () => ac.abort()
  }, [on])
  return { state, lines, error }
}

/** Card text: `code` becomes a chip that copies itself, **bold** stays bold, "- " lines are bullets. */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean)
  return (
    <>
      {parts.map((p, k) => {
        if (p.startsWith('`') && p.endsWith('`') && p.length > 2) {
          const code = p.slice(1, -1)
          return (
            <Press key={k} className="vk-call-code" title="Copy" onPress={() => { void copyText(code).then(() => toast('Copied', { ms: 1200 })) }}>
              {code}
            </Press>
          )
        }
        if (p.startsWith('**') && p.endsWith('**') && p.length > 4) return <b key={k}>{p.slice(2, -2)}</b>
        return <span key={k}>{p}</span>
      })}
    </>
  )
}

function CardBody({ body }: { body: string }) {
  const rows = body.split('\n').map((r) => r.trimEnd()).filter((r) => r.trim())
  return (
    <div className="vk-call-cbody">
      {rows.map((r, k) => {
        const bullet = /^\s*([-*•]|\d+\.)\s+/.exec(r)
        return (
          <p key={k} data-bullet={bullet ? '' : undefined}>
            <Inline text={bullet ? r.slice(bullet[0].length) : r} />
          </p>
        )
      })}
    </div>
  )
}

function Card({ card, i, onDismiss }: { card: CallCard; i: number; onDismiss: () => void }) {
  return (
    <article className="vk-call-card vl-panel vl-build" style={iv(i)} data-ask={card.ask ? '' : undefined}>
      <header>
        <h3>{card.title}</h3>
        <IconButton icon="stop" size={14} label="Dismiss" className="vk-call-x" onPress={onDismiss} />
      </header>
      {card.ask && <p className="vk-call-asked">You asked: {card.ask}</p>}
      {card.body && <CardBody body={card.body} />}
      <footer>
        {clock(card.at)} ET
        {card.sources.length ? <> · {card.sources.join(' · ')}</> : null}
        <> · {(card.ms / 1000).toFixed(1)} s</>
      </footer>
    </article>
  )
}

/** What the caption side and the Claude side are doing, as one line. */
function statusOf(c: CallLive): { text: string; warn: boolean; busy: boolean } {
  if (c.hearing === 'starting') return { text: 'Loading Whisper', warn: false, busy: true }
  if (c.hearing === 'off' || c.hearing === 'error') return { text: 'Not hearing the call', warn: true, busy: false }
  if (c.brain === 'starting') return { text: 'Claude is starting', warn: false, busy: true }
  if (c.brain === 'error') return { text: 'Claude is off for this call', warn: true, busy: false }
  if (c.activity) return { text: c.activity === 'Thinking' ? 'Claude is reading' : `Looking up ${c.activity}`, warn: false, busy: true }
  return { text: 'Listening', warn: false, busy: false }
}

function Transcript({ lines, partial }: { lines: CallLine[]; partial: string }) {
  const box = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  useLayoutEffect(() => {
    const el = box.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [lines, partial])
  return (
    <div
      ref={box}
      className="vk-call-lines"
      onScroll={(e) => {
        const el = e.currentTarget
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      }}
    >
      {!lines.length && !partial && <p className="vk-call-empty">The call's words show here.</p>}
      {lines.map((l) => (
        <p key={l.n} data-me={l.who === 'me' || undefined}><time>{clock(l.at)}</time><span>{l.who === 'me' && <b>You </b>}{l.text}</span></p>
      ))}
      {partial && <p className="vk-call-partial"><time />{partial}</p>}
    </div>
  )
}

function LiveCall({ c, lines, standalone }: { c: CallLive; lines: CallLine[]; standalone: boolean }) {
  const now = useTick(1000)
  const [ending, setEnding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [ask, setAsk] = useState('')
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set())
  const st = statusOf(c)
  const hears = c.devices ? `Hearing ${[c.devices.caller, c.devices.me].filter(Boolean).join(' and ')}` : undefined
  const cards = c.cards.filter((k) => !hidden.has(k.id)).slice().reverse()

  useEffect(() => {
    if (!ending) return
    const t = setTimeout(() => setEnding(false), 6000)
    return () => clearTimeout(t)
  }, [ending])

  const end = (save: boolean) => {
    if (busy) return
    setBusy(true)
    stopCall(save)
      .then((r) => toast(
        r.last.saved
          ? `Call ended. Transcript saved to your notes${r.last.video ? ', recording on its way to odin' : ''}.`
          : 'Call ended. Nothing kept.',
        { ms: 3500 },
      ))
      .catch((e) => toast(`Could not end the call: ${errText(e)}`, { ms: 5000 }))
      .finally(() => { setBusy(false); setEnding(false) })
  }
  const send = () => {
    const text = ask.trim()
    if (!text) return
    setAsk('')
    askCall(text).catch((e) => {
      setAsk(text)
      toast(`Claude did not get that: ${errText(e)}`, { ms: 5000 })
    })
  }
  const dismiss = (id: string) => {
    setHidden((s) => new Set(s).add(id))
    dismissCallCard(id).catch(() => { /* hidden here either way */ })
  }

  return (
    <div className="vk-call vk-call-on">
      <header className="vk-call-bar">
        <span className="vk-call-live"><i aria-hidden />Live <b>{elapsed(now - Date.parse(c.startedAt))}</b></span>
        <span className="vk-call-area">{c.area.label}</span>
        {(c.recording === 'on' || c.recording === 'starting') && (
          <span className="vk-call-rec" data-on={c.recording === 'on' || undefined} title="Recording the screen the call is on, and the audio">REC</span>
        )}
        <span className="vk-call-status vl-ellipsis" data-warn={st.warn || undefined} title={hears}>
          <Icon name={st.warn ? 'alert' : st.busy ? 'refresh' : 'online'} size={13} tone={st.warn ? 'acc2' : st.busy ? 'fg' : 'dim'} className={st.busy ? 'vl-pulse' : undefined} />
          {st.text}
        </span>
        <span className="vk-call-gap" />
        {!standalone && canDetach() && <IconButton icon="popout" size={15} label="Open in its own window" onPress={() => openDetached({ kind: 'call' })} />}
        {ending ? (
          <span className="vk-call-end">
            <Button kind="line" lit disabled={busy} onPress={() => end(true)} title={c.recording ? 'Keeps the transcript and the recording' : 'Keeps the transcript'}>Save and end</Button>
            <Button kind="line" disabled={busy} onPress={() => end(false)} title={c.recording ? 'Deletes the transcript and the recording' : 'Deletes the transcript'}>End</Button>
          </span>
        ) : (
          <Button kind="line" icon="stop" onPress={() => setEnding(true)}>End</Button>
        )}
      </header>

      {c.error && <p className="vk-call-err"><Icon name="alert" size={14} tone="acc2" glow />{c.error}</p>}

      <form className="vk-call-ask" onSubmit={(e) => { e.preventDefault(); send() }}>
        <Icon name="asking" size={15} tone="dim" />
        <input
          value={ask}
          onChange={(e) => setAsk(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
            e.preventDefault()
            send()
          }}
          placeholder="Ask Claude about this call"
          enterKeyHint="send"
          maxLength={2000}
          aria-label="Ask Claude"
        />
        {ask.trim() && <IconButton icon="enter" size={15} label="Send" onPress={send} />}
      </form>

      <div className="vk-call-body">
        <section className="vk-call-cards" aria-label="Suggestions">
          {c.draft && (
            <article className="vk-call-card vk-call-draft vl-panel">
              <header><h3 className="vl-ellipsis">{c.draft.split('\n')[0]}</h3></header>
              <CardBody body={c.draft.split('\n').slice(1).join('\n')} />
            </article>
          )}
          {cards.map((k, i) => <Card key={k.id} card={k} i={i} onDismiss={() => dismiss(k.id)} />)}
          {!cards.length && !c.draft && (
            <p className="vk-call-empty">Suggestions show here when the caller asks something or describes a problem.</p>
          )}
        </section>
        <section className="vk-call-script" aria-label="Transcript">
          <h2>Transcript <span>{c.lineCount} lines · ET</span></h2>
          <Transcript lines={lines} partial={c.partial} />
        </section>
      </div>
    </div>
  )
}

function Idle({ state, standalone }: { state: CallState | null; standalone: boolean }) {
  const areas = state?.areas ?? []
  const [area, setArea] = useState(() => localStorage.getItem(AREA_KEY) ?? '')
  const [starting, setStarting] = useState(false)
  const [record, setRecord] = useState(() => localStorage.getItem(REC_KEY) !== '0')
  const pick = areas.some((a) => a.id === area) ? area : areas[0]?.id ?? ''
  const last = state?.last
  const start = () => {
    if (!pick || starting) return
    setStarting(true)
    localStorage.setItem(AREA_KEY, pick)
    startCall(pick, record)
      .catch((e) => toast(`Could not start: ${errText(e)}`, { ms: 5000 }))
      .finally(() => setStarting(false))
  }
  return (
    <div className="vk-call">
      <section className="vk-call-idle vl-panel vl-build" style={iv(0)}>
        <header className="vk-call-head">
          <Icon name="call" size={15} tone="fg" glow />
          <span className="vk-call-label">Call</span>
          {!standalone && canDetach() && (
            <IconButton icon="popout" size={15} label="Open in its own window" className="vk-call-pop" onPress={() => openDetached({ kind: 'call' })} />
          )}
        </header>
        <p className="vk-call-note">
          thor writes the call down with Whisper on its own GPU, and Claude suggests answers while the caller talks.
          It hears what thor plays (the other side of a Teams, Zoom or Discord call) and your mic.
        </p>
        <p className="vk-call-note">
          With recording on, it also records the screen the call is on. Save and end files the video on odin under the
          client's name; End deletes it.
        </p>
        {areas.length > 1 && (
          <Segmented options={areas.map((a) => ({ value: a.id, label: a.label }))} value={pick} onChange={setArea} className="vk-call-areas" />
        )}
        <div className="vk-call-go">
          <Button icon="call" disabled={!pick || starting || state?.status === 'stopping'} onPress={start}>
            {starting ? 'Starting' : 'Start listening'}
          </Button>
          <Button
            kind="line"
            icon="video"
            lit={record}
            className="vk-call-recbtn"
            aria-pressed={record}
            onPress={() => {
              const v = !record
              setRecord(v)
              localStorage.setItem(REC_KEY, v ? '1' : '0')
            }}
          >
            {record ? 'Recording on' : 'Recording off'}
          </Button>
        </div>
        {last && (
          <p className="vk-call-last">
            Last call: {last.area}, {clock(last.startedAt)} to {clock(last.endedAt)} ET, {last.lines} lines, {last.cards} cards.
            {last.saved ? ' Saved to your notes.' : ' Not saved.'}
            {last.saving && ' Saving the recording.'}
            {!last.saving && last.video && ` Video: call-recordings\\${shortVideo(last.video)}${last.videoMb != null ? ` (${last.videoMb} MB)` : ''}.`}
            {last.videoError && ` The recording was not saved: ${last.videoError}.`}
          </p>
        )}
      </section>
    </div>
  )
}

/** AI > Call. `active`: the tab is on screen (the poll runs only then). */
export function CallView({ active, standalone = false }: { active: boolean; standalone?: boolean }) {
  const { state, lines, error } = useCallState(active)
  const c = state?.call
  return (
    <>
      {error && !state && <p className="vk-call-err vk-call-solo"><Icon name="alert" size={14} tone="acc2" glow />thor's call service did not answer: {error}</p>}
      {error && state && <p className="vk-call-err vk-call-solo"><Icon name="refresh" size={14} tone="acc2" className="vl-pulse" />Reconnecting: {error}</p>}
      {c ? <LiveCall c={c} lines={lines} standalone={standalone} /> : state ? <Idle state={state} standalone={standalone} /> : !error && (
        <p className="vk-call-empty vk-call-solo"><Icon name="refresh" size={14} tone="dim" className="vl-pulse" />Reaching thor</p>
      )}
    </>
  )
}

/** /m/w/call: the call in a window of its own, kept on top of the call app. */
export function CallWindow() {
  const stored = useStoredMode()
  useLayoutEffect(() => { applyPalette(stored) }, [stored])
  useFont()
  useEffect(() => { setDetachedTitle('Call · Valkyrie') }, [])
  const win = desktopWindow()
  return (
    <div className="vk-callw" data-win={win || undefined}>
      <div className="vk-callw-backdrop" aria-hidden><DotFloor className="vl-floor-faint" /></div>
      <header className="vk-callw-head"><StatusStrip /></header>
      <main className={cx('vk-callw-main')}>
        <CallView active standalone />
      </main>
      <ToastHost />
    </div>
  )
}
