import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowUp, Bird, Check, FileText, Gauge, Mic, Paperclip, Square, X } from 'lucide-react'
import { Markdown } from '../../components/Markdown'
import { apiErrorText } from '../../lib/api'
import { useProfile } from '../../lib/deviceMode'
import {
  RULE_NAME, fmtSize, isImageFile, markRavenRead, ravenBusy, ravenStatusText, replyMetaLine, replyMetaTitle, sendRaven,
  type RavenFile, type RavenModelInfo, type RavenMsg, type RavenPage, type RavenPickEffort, type RavenRuleKey, type RavenSettings,
  type RavenSettingsPatch, type RavenTier,
} from '../../lib/ravenApi'
import {
  addToThread, openRavenQuick, refreshRavenUnread, setQuickOpen, setQuickOpener, useKeyboardInset, useQuickOpen, useRaven,
  useRavenDraft, useRavenFileUrl, useRavenUnread, useRavenVoice, useSaveRavenSettings, useVoiceSink, usePttKey, pttAllowed, pttLabel,
  pttMatches, voiceStart, voiceStop, voiceToggle, type DraftSnap, type PttKey, type RavenDraft,
} from './ravenStore'
import { useTick } from './data'
import { setRavenWidgetOn, useRavenWidgetOn } from '../../lib/ravenWidget'
import { requestIntent } from './shell'
import { Icon } from './icons'
import { Press, cx, toast } from './ui'
import './raven.css'

// Raven everywhere in v2: the composer the Raven screen and the quick sheet
// share, a message's attachments, the floating button in the bottom-right
// corner, the quick sheet it opens (also
// Ctrl+Shift+Space and the palette's "Message Raven"), and the unread badge on
// the Raven tab. The state behind them is kit/ravenStore.ts. The Dashboard has
// its own Raven block (screens/Dashboard.tsx RavenBlock), so the corner button
// stays off there.

/** a fine pointer: Enter sends there; a touch keyboard's return is a new line */
const finePointer = () => typeof window !== 'undefined' && window.matchMedia('(hover: hover) and (pointer: fine)').matches

const ACCEPT = 'image/*,video/*,application/pdf,text/*,*/*'

// ---------------------------------------------------------------- composer ---

/**
 * The box he writes in, one rounded box: the attachments picked so far (each
 * uploading as soon as it is picked, with its percent, Retry and remove), an
 * attach button (on the phone it offers the camera and the photo library), the
 * text and a round Send arrow, lit when there is something to send.
 * Enter sends with a keyboard and mouse, Shift+Enter is a new line; a pasted
 * or dropped file attaches.
 */
export function RavenComposer({ draft, onSend, sending, placeholder, taRef, className, maxHeight = 180, tools, voiceOn = true }: {
  draft: RavenDraft
  onSend: () => void
  sending: boolean
  placeholder: string
  /** the text box, for the owner to focus */
  taRef: RefObject<HTMLTextAreaElement | null>
  className?: string
  maxHeight?: number
  /** small controls between the text and Send (the model and effort pick) */
  tools?: ReactNode
  /** this box is on screen: voice input (the mic, push to talk) writes into it */
  voiceOn?: boolean
}) {
  const pick = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const fileUrl = useRavenFileUrl()
  // the words from a recording join the end of what is there, for him to read and edit; never sent by themselves
  const voiceId = useVoiceSink(voiceOn, (words) => {
    draft.append(words)
    const el = taRef.current
    if (el) requestAnimationFrame(() => { el.focus({ preventScroll: true }); el.setSelectionRange(el.value.length, el.value.length) })
  })
  const voice = useRavenVoice()
  const mine = voice.phase !== 'idle' && (voice.owner === voiceId || (voice.owner === null && voiceOn))
  const recording = mine && (voice.phase === 'recording' || voice.phase === 'starting')
  const writing = mine && voice.phase === 'writing'
  // the draft is shared, so the text can change while this box is hidden (the closed quick sheet): measure again
  // once it shows, and never pin a hidden box to 0 px
  useLayoutEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    if (el.scrollHeight) el.style.height = `${Math.min(maxHeight, el.scrollHeight)}px`
  }, [draft.text, maxHeight, taRef, voiceOn])

  const submit = () => {
    if (draft.ready && !sending) onSend()
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && finePointer()) {
      e.preventDefault()
      submit()
    }
  }
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? [])
    if (!files.length) return
    // a screenshot pastes as a file alone; copied text with a picture keeps the text
    if (!e.clipboardData.getData('text/plain')) e.preventDefault()
    draft.add(files)
  }
  const drag = {
    onDragOver: (e: DragEvent) => {
      if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return
      e.preventDefault()
      setOver(true)
    },
    onDragLeave: () => setOver(false),
    onDrop: (e: DragEvent) => {
      setOver(false)
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (!files.length) return
      e.preventDefault()
      draft.add(files)
    },
  }

  return (
    <form className={cx('rv-compose', className)} data-over={over || undefined} data-rec={recording || undefined} onSubmit={(e) => { e.preventDefault(); submit() }} {...drag}>
      {(recording || writing) && <VoiceLine phase={voice.phase} since={voice.since} ptt={voice.ptt} />}
      {draft.files.length > 0 && (
        <div className="rv-chips" aria-label="Attachments">
          {draft.files.map((f) => {
            // a picture kept from before a reload draws from odin, where it landed
            const src = f.preview ?? (f.state === 'done' && f.file && isImageFile(f.file) ? fileUrl(f.file.id) : null)
            return (
            <span key={f.key} className="rv-chip" data-state={f.state}>
              {src ? <img src={src} alt="" draggable={false} /> : <FileText size={14} strokeWidth={1.6} className="vl-icon vl-icon-dim" aria-hidden />}
              <span className="rv-chip-name">{f.name}</span>
              <span className="rv-chip-state">
                {f.state === 'up' ? `${f.size ? Math.min(99, Math.floor((f.sent / f.size) * 100)) : 0}%` : f.state === 'err' ? f.error ?? 'failed' : fmtSize(f.size)}
              </span>
              {f.state === 'err' && !f.lost && f.error !== 'over 50 MB' && f.error !== 'empty' && (
                <Press className="rv-chip-act" onPress={() => draft.retry(f.key)}>Retry</Press>
              )}
              <Press className="rv-chip-x" aria-label={`Remove ${f.name}`} onPress={() => draft.remove(f.key)}>
                <X size={12} strokeWidth={1.8} className="vl-icon vl-icon-dim" aria-hidden />
              </Press>
            </span>
            )
          })}
        </div>
      )}
      <div className="rv-compose-row">
        <Press className="rv-attach" aria-label="Attach a file or photo" title="Attach" onPress={() => pick.current?.click()}>
          <Paperclip size={17} strokeWidth={1.5} className="vl-icon vl-icon-dim" aria-hidden />
        </Press>
        <input
          ref={pick}
          type="file"
          multiple
          accept={ACCEPT}
          className="rv-pick"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            if (e.currentTarget.files) draft.add(e.currentTarget.files)
            e.currentTarget.value = ''
          }}
        />
        <textarea
          ref={taRef}
          rows={1}
          value={draft.text}
          onChange={(e) => draft.setText(e.target.value)}
          onKeyDown={onKey}
          onPaste={onPaste}
          placeholder={placeholder}
          aria-label={placeholder}
          enterKeyHint="send"
        />
        <Press
          type="button"
          className="rv-mic"
          data-on={recording || undefined}
          data-busy={writing || undefined}
          aria-pressed={recording}
          aria-label={recording ? 'Stop recording' : writing ? 'Writing the recording down' : 'Record a voice message'}
          title={recording ? 'Stop recording' : 'Record a voice message'}
          disabled={writing || (voice.phase !== 'idle' && !mine)}
          onPress={() => voiceToggle(voiceId)}
        >
          {recording ? <Square size={13} strokeWidth={2.4} aria-hidden /> : <Mic size={17} strokeWidth={1.6} className="vl-icon" aria-hidden />}
        </Press>
        {tools}
        <Press
          type="button"
          className="rv-send"
          data-ready={(draft.ready && !sending) || undefined}
          disabled={!draft.ready || sending}
          aria-label={draft.uploading ? 'Wait for the upload' : 'Send'}
          title={draft.uploading ? 'Wait for the upload' : 'Send'}
          onPress={submit}
        >
          <ArrowUp size={17} strokeWidth={2.2} aria-hidden />
        </Press>
      </div>
    </form>
  )
}

/** Over the box while it records: a red dot, "Recording 0:07" and how to stop; then "Writing it down". */
function VoiceLine({ phase, since, ptt }: { phase: string; since: number; ptt: boolean }) {
  const now = useTick(phase === 'writing' ? 60_000 : 500)
  const [key] = usePttKey()
  if (phase === 'writing') return <div className="rv-rec" data-phase="writing" role="status">Writing it down</div>
  const secs = Math.max(0, Math.floor((now - since) / 1000))
  const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
  return (
    <div className="rv-rec" data-phase="recording" role="status">
      <span className="rv-rec-dot" aria-hidden />
      <span>{phase === 'starting' ? 'Starting the microphone' : `Recording ${clock}`}</span>
      <span className="rv-rec-how">{ptt && key ? `release ${pttLabel(key)} to stop` : 'tap the square to stop'}</span>
    </div>
  )
}

// ------------------------------------------------- the model and effort pick ---

const EFFORT_NAME: Record<RavenPickEffort, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max' }
const PICK_EFFORTS: RavenPickEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const RULE_NOTE: Record<RavenRuleKey, string> = {
  simple: 'Quick lookups, grocery adds, one quick action',
  complex: 'Several steps, work tickets, client mail, planning',
  voice: 'Siri. Not sorted first, so the spoken answer is quick',
  background: 'Relays and follow-ups you did not start',
}
const RULE_ORDER: RavenRuleKey[] = ['simple', 'complex', 'voice', 'background']

/**
 * Two small text buttons in the composer, left of Send: the model Raven runs on and the effort, each Automatic or
 * fixed. Each opens a short menu upward; both menus end with Automatic rules, the panel where he sets what
 * Automatic uses. The pick lives on odin (every device shows the same one) and comes with the Raven page.
 */
export function RavenPick({ page }: { page: RavenPage | undefined }) {
  const [menu, setMenu] = useState<null | 'model' | 'effort'>(null)
  const [rules, setRules] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const save = useSaveRavenSettings()

  useEffect(() => {
    if (!menu) return
    const away = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setMenu(null) }
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // the menu closes, not the quick sheet around it
      e.preventDefault()
      e.stopPropagation()
      setMenu(null)
    }
    document.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', esc, true)
    return () => { document.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', esc, true) }
  }, [menu])

  const s = page?.settings
  if (!s) return null
  const models = page?.models ?? []
  const nameOf = (k: RavenTier) => models.find((m) => m.key === k)?.label ?? k
  const modelText = s.model === 'auto' ? 'Auto' : nameOf(s.model)
  const effortText = s.effort === 'auto' ? 'auto' : s.effort
  const pick = (patch: RavenSettingsPatch) => { setMenu(null); save.mutate(patch) }
  const openRules = () => { setMenu(null); setRules(true) }
  const item = (on: boolean, label: string, onPress: () => void, note?: string) => (
    <Press key={label} role="menuitemradio" aria-checked={on} className="rv-menu-item" data-on={on || undefined} onPress={onPress}>
      <Check size={13} strokeWidth={2} className="rv-menu-check" aria-hidden />
      <span className="rv-menu-label">{label}</span>
      {note && <span className="rv-menu-note">{note}</span>}
    </Press>
  )

  return (
    <div className="rv-pick-wrap" ref={wrap}>
      <Press
        className="rv-pickb"
        data-on={menu === 'model' || undefined}
        data-fixed={s.model !== 'auto' || undefined}
        aria-haspopup="menu"
        aria-expanded={menu === 'model'}
        aria-label={`Model: ${s.model === 'auto' ? 'Automatic' : modelText}`}
        title="The model Raven runs on"
        onPress={() => setMenu((m) => (m === 'model' ? null : 'model'))}
      >
        <span>{modelText}</span>
      </Press>
      <Press
        className="rv-pickb"
        data-on={menu === 'effort' || undefined}
        data-fixed={s.effort !== 'auto' || undefined}
        aria-haspopup="menu"
        aria-expanded={menu === 'effort'}
        aria-label={`Effort: ${s.effort === 'auto' ? 'Automatic' : EFFORT_NAME[s.effort]}`}
        title="How hard Raven thinks"
        onPress={() => setMenu((m) => (m === 'effort' ? null : 'effort'))}
      >
        <Gauge size={13} strokeWidth={1.7} className="vl-icon" aria-hidden />
        <span>{effortText}</span>
      </Press>
      {menu === 'model' && (
        <div className="rv-menu" role="menu" aria-label="Model">
          {item(s.model === 'auto', 'Automatic', () => pick({ model: 'auto' }), 'per message')}
          {models.map((m) => item(s.model === m.key, m.label, () => pick({ model: m.key }), m.unavailable ? `${m.unavailable}${m.fallback ? `, runs ${m.fallback}` : ''}` : undefined))}
          <Press role="menuitem" className="rv-menu-item rv-menu-more" onPress={openRules}>Automatic rules</Press>
        </div>
      )}
      {menu === 'effort' && (
        <div className="rv-menu" role="menu" aria-label="Effort">
          {item(s.effort === 'auto', 'Automatic', () => pick({ effort: 'auto' }), 'per message')}
          {PICK_EFFORTS.map((e) => item(s.effort === e, EFFORT_NAME[e], () => pick({ effort: e })))}
          <Press role="menuitem" className="rv-menu-item rv-menu-more" onPress={openRules}>Automatic rules</Press>
        </div>
      )}
      {rules && <RavenRules settings={s} models={models} onClose={() => setRules(false)} />}
    </div>
  )
}

/**
 * Automatic rules: what Automatic uses for each kind of run, a model and an effort per row. Each change saves at
 * once. A dialog over everything (the quick sheet too); Escape, Done or a tap outside closes it.
 */
function RavenRules({ settings, models, onClose }: { settings: RavenSettings; models: RavenModelInfo[]; onClose: () => void }) {
  const save = useSaveRavenSettings()
  const box = useRef<HTMLElement>(null)
  useEffect(() => {
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', esc, true)
    box.current?.focus({ preventScroll: true })
    return () => window.removeEventListener('keydown', esc, true)
  }, [onClose])
  const fixed = [settings.model !== 'auto' && 'model', settings.effort !== 'auto' && 'effort'].filter(Boolean)
  return createPortal(
    <div className="rv-rules">
      <div className="rv-rules-back" onPointerDown={onClose} aria-hidden />
      <section className="rv-rules-box" role="dialog" aria-modal="true" aria-label="Automatic rules" tabIndex={-1} ref={box}>
        <header className="rv-rules-head">
          <b>Automatic rules</b>
          <Press className="rv-q-x" aria-label="Close" onPress={onClose}><X size={15} strokeWidth={1.6} className="vl-icon vl-icon-dim" aria-hidden /></Press>
        </header>
        <p className="rv-rules-lead">
          What Raven uses when the model or the effort is set to Automatic. Raven sorts each message you type as simple or complex. The same on every device.
        </p>
        {fixed.length > 0 && <p className="rv-rules-lead rv-rules-fixed">Your {fixed.join(' and ')} pick is fixed now, so the rules give only the rest.</p>}
        <div className="rv-rules-grid" role="table" aria-label="Rules">
          <div role="row" className="rv-rules-row rv-rules-cols">
            <span role="columnheader" />
            <span role="columnheader">Model</span>
            <span role="columnheader">Effort</span>
          </div>
          {RULE_ORDER.map((k) => {
            const r = settings.rules[k]
            return (
              <div key={k} role="row" className="rv-rules-row" data-rule={k}>
                <span role="rowheader" className="rv-rules-name">
                  <b>{RULE_NAME[k]}</b>
                  <i>{RULE_NOTE[k]}</i>
                </span>
                <span role="cell">
                  <select aria-label={`${RULE_NAME[k]}: model`} value={r.model} onChange={(e) => save.mutate({ rules: { [k]: { model: e.target.value as RavenTier } } })}>
                    {models.map((m) => <option key={m.key} value={m.key}>{m.label}{m.unavailable ? ` (${m.unavailable})` : ''}</option>)}
                  </select>
                </span>
                <span role="cell">
                  <select aria-label={`${RULE_NAME[k]}: effort`} value={r.effort} onChange={(e) => save.mutate({ rules: { [k]: { effort: e.target.value as RavenPickEffort } } })}>
                    {PICK_EFFORTS.map((x) => <option key={x} value={x}>{EFFORT_NAME[x]}</option>)}
                  </select>
                </span>
              </div>
            )
          })}
        </div>
        <footer className="rv-rules-foot">
          <Press className="rv-rules-reset" onPress={() => save.mutate({ reset: true })}>Reset to defaults</Press>
          <Press className="rv-rules-done" onPress={onClose}>Done</Press>
        </footer>
      </section>
    </div>,
    document.body,
  )
}

/**
 * Settings: the push-to-talk key on this device. Change listens for the next key: a function key, or one held with
 * Ctrl, Alt or Win (a plain letter would stop him typing it); Escape cancels, Backspace turns push to talk off.
 */
export function PushToTalkRow() {
  const [key, setKey] = usePttKey()
  const [listening, setListening] = useState(false)
  useEffect(() => {
    if (!listening) return
    const on = (e: globalThis.KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') { setListening(false); return }
      if (e.key === 'Backspace' || e.key === 'Delete') { setKey(null); setListening(false); return }
      if (['Control', 'Shift', 'Alt', 'Meta', 'OS'].includes(e.key)) return
      const k: PttKey = { code: e.code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey }
      if (!pttAllowed(k)) { toast('Pick a function key (F1 to F24), or a key held with Ctrl or Alt', { ms: 4000 }); return }
      setKey(k)
      setListening(false)
    }
    window.addEventListener('keydown', on, true)
    return () => window.removeEventListener('keydown', on, true)
  }, [listening, setKey])
  return (
    <div className="st-row rv-ptt-row">
      <span className="st-row-icon st-row-glyph" aria-hidden><Mic size={14} strokeWidth={1.7} className="vl-icon vl-icon-dim" /></span>
      <span className="st-row-label">Push to talk</span>
      <span className="st-row-value vl-ellipsis" data-listening={listening || undefined}>
        {listening ? 'Press the key to use. Esc cancels, Backspace turns it off' : key ? `Hold ${pttLabel(key)} to talk to Raven` : 'Off'}
      </span>
      <Press className="vl-link vl-hit st-row-act" onPress={() => setListening((v) => !v)}>{listening ? 'Cancel' : 'Change'}</Press>
    </div>
  )
}

/** Settings, desktop app only: the Raven widget on the desktop on or off (it is on unless turned off). */
export function RavenWidgetRow() {
  const on = useRavenWidgetOn()
  const [busy, setBusy] = useState(false)
  if (on === null) return null
  const flip = () => {
    setBusy(true)
    void setRavenWidgetOn(!on)
      .catch((e) => toast(`Could not change the widget: ${String(e)}`, { ms: 4000 }))
      .finally(() => setBusy(false))
  }
  return (
    <div className="st-row">
      <span className="st-row-icon st-row-glyph" aria-hidden><Bird size={14} strokeWidth={1.7} className="vl-icon vl-icon-dim" /></span>
      <span className="st-row-label">Raven widget</span>
      <span className="st-row-value vl-ellipsis">{on ? 'On the desktop behind every app, hides after 5 minutes idle' : 'Off'}</span>
      <Press className="vl-link vl-hit st-row-act" disabled={busy} onPress={flip}>{on ? 'Turn off' : 'Turn on'}</Press>
    </div>
  )
}

// ------------------------------------------------------------ attachments ---

/** A message's files: pictures as thumbnails, anything else as a name chip; each opens the file. */
export function RavenFiles({ files }: { files: RavenFile[] }) {
  const url = useRavenFileUrl()
  if (!files.length) return null
  return (
    <div className="rv-files">
      {files.map((f) => {
        const href = url(f.id)
        if (isImageFile(f)) {
          return href
            ? <a key={f.id} className="rv-thumb" href={href} target="_blank" rel="noopener noreferrer" title={f.name}><img src={href} alt={f.name} loading="lazy" draggable={false} /></a>
            : <span key={f.id} className="rv-thumb" title={f.name} />
        }
        const label = <><FileText size={13} strokeWidth={1.6} className="vl-icon vl-icon-dim" aria-hidden /><span>{f.name}</span><i>{fmtSize(f.size)}</i></>
        return href
          ? <a key={f.id} className="rv-file" href={href} target="_blank" rel="noopener noreferrer">{label}</a>
          : <span key={f.id} className="rv-file">{label}</span>
      })}
    </div>
  )
}

// ------------------------------------------------------------- the badge ---

/**
 * Raven's unread count on the Raven tab. The number is drawn by CSS from
 * data-n, so the tab's text stays its name (the tests and the palette find
 * tabs by it).
 */
export function RavenBadge() {
  const n = useRavenUnread().data?.unread ?? 0
  if (!n) return null
  return <span className="rv-badge" data-n={n > 99 ? '99+' : String(n)} title={`${n} unread`} aria-hidden />
}

// ------------------------------------------------------ the floating button ---

/** Raven's own tab, and the Dashboard's Overview, which has the Raven block: no corner button there (one Raven entry per screen). */
const NO_FAB = /^\/m\/(raven|messages)(\/|$)|^\/m\/dashboard(\/overview)?\/?$/

/**
 * Bottom-right on every tab but Raven and the Dashboard's Overview, the lights
 * button's twin: one tap opens the quick sheet with its box focused. Not in
 * the headset.
 */
export function RavenFab() {
  const { pathname } = useLocation()
  const vr = useProfile().resolved === 'vr'
  const open = useQuickOpen()
  const unread = useRavenUnread().data?.unread ?? 0
  // the desktop app's own Raven widget is on screen: one Raven button, not two
  const widget = useRavenWidgetOn()
  if (vr || widget || NO_FAB.test(pathname)) return null
  const label = unread ? `Message Raven (${unread} unread)` : 'Message Raven'
  return (
    <Press
      className="rv-fab"
      data-on={open || undefined}
      data-unread={unread || undefined}
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={open}
      title={`${label}: Ctrl+Shift+Space`}
      onPress={() => (open ? setQuickOpen(false) : openRavenQuick())}
    >
      <Icon name={Bird} size={20} tone={open || unread ? 'fg' : 'dim'} glow={open || unread > 0} />
    </Press>
  )
}

// --------------------------------------------------------- the quick sheet ---

/** The reply to the line he sent: Raven's first answer naming it, else Raven's next own line after it. */
function replyTo(messages: RavenMsg[], id: number): RavenMsg | null {
  const after = messages.filter((m) => m.id > id && m.author === 'raven' && !m.meta.relay)
  return after.find((m) => m.meta.replyTo === id) ?? after.find((m) => m.meta.replyTo === undefined) ?? null
}

/**
 * The quick sheet: a box to send Raven a line from anywhere, with attach and
 * Send. On the phone it is a bottom sheet over the keyboard; on a wider
 * screen a small popover in the bottom-right corner. After a send it shows
 * the line, Raven's status, then the reply, with Open conversation. Escape or
 * a tap outside closes it; what he typed stays for the next time (the thread's draft, kept on the device and shown
 * in the Raven tab too). Mounted
 * once by v2/App.tsx.
 */
export function RavenQuick() {
  const open = useQuickOpen()
  const ta = useRef<HTMLTextAreaElement>(null)
  const location = useLocation()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const draft = useRavenDraft()
  const [sent, setSent] = useState<RavenMsg | null>(null)
  const raven = useRaven(open)
  const kb = useKeyboardInset(open)

  // the opener runs inside the tap: render open now, then focus, so iOS raises the keyboard
  useEffect(() => {
    setQuickOpener(() => {
      if (requestIntent('raven:compose')) return
      flushSync(() => setQuickOpen(true))
      ta.current?.focus({ preventScroll: true })
      // a closing palette hands the focus back after this; take it again
      requestAnimationFrame(() => { if (document.activeElement !== ta.current) ta.current?.focus({ preventScroll: true }) })
    })
    return () => setQuickOpener(null)
  }, [])

  // push to talk: hold the key (Settings, F8 by default) anywhere in v2; the words land in the Raven tab's box when
  // it is in front, else the quick sheet opens and takes them
  const [ptt] = usePttKey()
  useEffect(() => {
    if (!ptt) return
    let held = false
    const down = (e: globalThis.KeyboardEvent) => {
      if (!pttMatches(e, ptt)) return
      e.preventDefault()
      e.stopPropagation()
      if (e.repeat || held) return
      held = true
      openRavenQuick()
      void voiceStart(null, true)
    }
    const up = (e: globalThis.KeyboardEvent) => {
      if (e.code !== ptt.code || !held) return
      held = false
      e.preventDefault()
      voiceStop()
    }
    const lost = () => { if (held) { held = false; voiceStop() } }
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    window.addEventListener('blur', lost)
    return () => {
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
      window.removeEventListener('blur', lost)
    }
  }, [ptt])

  // Ctrl+Shift+Space anywhere in v2, the office's one key (thor sends the chord)
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return
      if (e.code !== 'Space' && e.key !== ' ') return
      e.preventDefault()
      e.stopPropagation()
      openRavenQuick()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // a new page closes it (Open conversation, a link in the reply, the back gesture)
  const path = location.pathname
  const lastPath = useRef(path)
  useEffect(() => {
    if (lastPath.current !== path) setQuickOpen(false)
    lastPath.current = path
  }, [path])

  useEffect(() => {
    if (!open) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      setQuickOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const send = useMutation({
    mutationFn: (snap: DraftSnap) => sendRaven({ text: snap.text.trim(), files: snap.ids.length ? snap.ids : undefined, source: 'quick' }),
    onSuccess: (m, snap) => {
      setSent(m)
      draft.markSent(snap)
      addToThread(qc, { messages: [m] })
      void qc.invalidateQueries({ queryKey: ['raven'] })
    },
    onError: (e) => toast(apiErrorText(e, 'Raven did not answer'), { ms: 4000 }),
  })

  const page = raven.data
  const reply = sent && page ? replyTo(page.messages, sent.id) : null
  const replyId = reply?.id ?? 0
  // closed after the reply came: the next open starts clean (a line still waiting stays, to see its answer)
  const [wasOpen, setWasOpen] = useState(open)
  if (wasOpen !== open) {
    setWasOpen(open)
    if (!open && reply) setSent(null)
  }
  const unread = page?.unread ?? 0
  useEffect(() => {
    if (!open || !replyId || !unread) return
    void markRavenRead(replyId).then(() => refreshRavenUnread(qc), () => { /* the badge stays until the next read */ })
  }, [open, replyId, unread, qc])

  const close = () => setQuickOpen(false)
  const toThread = () => {
    close()
    navigate('/m/raven', { state: { v2Back: true } })
  }
  const busy = ravenBusy(page)
  const status = page ? ravenStatusText(page) : ''

  return createPortal(
    <div
      className="rv-q"
      hidden={!open}
      data-sent={sent ? '' : undefined}
      // The box keeps the focus: the tap that opened the sheet still sends its mouse events after it (a
      // touch screen's compatibility click, landing on the sheet or the backdrop), and a mousedown on
      // anything that takes no text would take the focus off the box. The reply keeps its mousedown, so
      // its text can be selected.
      onMouseDownCapture={(e) => {
        const el = e.target as HTMLElement
        if (el.closest('.rv-q-thread, input, textarea, select, [contenteditable="true"]')) return
        e.preventDefault()
      }}
    >
      <div className="rv-q-back" onPointerDown={close} onMouseDown={(e) => e.preventDefault()} aria-hidden />
      <section
        className="rv-q-sheet"
        role="dialog"
        aria-modal={open ? 'true' : undefined}
        aria-label="Message Raven"
        style={kb ? { bottom: `${kb}px` } : undefined}
      >
        <header className="rv-q-head">
          <b>Raven</b>
          <span className="rv-q-status" data-busy={busy || undefined} data-state={page?.status}>{status}</span>
          <Press className="rv-q-open" onPress={toThread}>Open conversation</Press>
          <Press className="rv-q-x" aria-label="Close" onPress={close}><X size={15} strokeWidth={1.6} className="vl-icon vl-icon-dim" aria-hidden /></Press>
        </header>
        {sent && (
          <div className="rv-q-thread">
            <p className="rv-q-me">{sent.text || (sent.meta.files?.length ? `${sent.meta.files.length} ${sent.meta.files.length === 1 ? 'file' : 'files'}` : '')}</p>
            {sent.meta.files && sent.meta.files.length > 0 && <RavenFiles files={sent.meta.files} />}
            {reply
              ? (
                <div className="rv-q-reply">
                  <Markdown className="rv-md">{reply.text}</Markdown>
                  <p className="rv-meta" title={replyMetaTitle(reply.meta)}>{replyMetaLine(reply.meta, reply.createdAt)}</p>
                </div>
              )
              : <p className="rv-q-wait" data-busy={busy || undefined}>{busy ? status : 'Sent. Raven answers here and in the Raven tab.'}</p>}
          </div>
        )}
        <RavenComposer
          draft={draft}
          sending={send.isPending}
          onSend={() => send.mutate(draft.snapshot())}
          placeholder={sent ? 'Reply to Raven' : 'Message Raven'}
          taRef={ta}
          className="rv-q-compose"
          maxHeight={140}
          tools={<RavenPick page={page} />}
          voiceOn={open}
        />
      </section>
    </div>,
    document.body,
  )
}
