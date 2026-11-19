import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type RefObject } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Bird, FileText, Paperclip, X } from 'lucide-react'
import { Markdown } from '../../components/Markdown'
import { apiErrorText } from '../../lib/api'
import { useProfile } from '../../lib/deviceMode'
import {
  etTime, fmtSize, isImageFile, markRavenRead, modelLabel, ravenBusy, ravenStatusText, sendRaven, type RavenFile, type RavenMsg,
} from '../../lib/ravenApi'
import {
  addToThread, openRavenQuick, refreshRavenUnread, setQuickOpen, setQuickOpener, useKeyboardInset, useQuickOpen, useRaven,
  useRavenDraft, useRavenFileUrl, useRavenUnread, type RavenDraft,
} from './ravenStore'
import { requestIntent } from './shell'
import { Icon } from './icons'
import { Button, Press, cx, toast } from './ui'
import './raven.css'

// Raven everywhere in v2: the composer the Raven screen and the quick sheet
// share, a message's attachments, the floating button in the bottom-right
// corner (the lights button has the left), the quick sheet it opens (also
// Ctrl+Shift+Space and the palette's "Message Raven"), and the unread badge on
// the Raven tab. The state behind them is kit/ravenStore.ts. The Dashboard has
// its own Raven block (screens/Dashboard.tsx RavenBlock), so the corner button
// stays off there.

/** a fine pointer: Enter sends there; a touch keyboard's return is a new line */
const finePointer = () => typeof window !== 'undefined' && window.matchMedia('(hover: hover) and (pointer: fine)').matches

const ACCEPT = 'image/*,video/*,application/pdf,text/*,*/*'

// ---------------------------------------------------------------- composer ---

/**
 * The box he writes in: the attachments picked so far (each uploading as soon
 * as it is picked, with its percent, Retry and remove), an attach button (on
 * the phone it offers the camera and the photo library), the text and Send.
 * Enter sends with a keyboard and mouse, Shift+Enter is a new line; a pasted
 * or dropped file attaches.
 */
export function RavenComposer({ draft, onSend, sending, placeholder, taRef, className, maxHeight = 180 }: {
  draft: RavenDraft
  onSend: () => void
  sending: boolean
  placeholder: string
  /** the text box, for the owner to focus */
  taRef: RefObject<HTMLTextAreaElement | null>
  className?: string
  maxHeight?: number
}) {
  const pick = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  useLayoutEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(maxHeight, el.scrollHeight)}px`
  }, [draft.text, maxHeight, taRef])

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
    <form className={cx('rv-compose', className)} data-over={over || undefined} onSubmit={(e) => { e.preventDefault(); submit() }} {...drag}>
      {draft.files.length > 0 && (
        <div className="rv-chips" aria-label="Attachments">
          {draft.files.map((f) => (
            <span key={f.key} className="rv-chip" data-state={f.state}>
              {f.preview ? <img src={f.preview} alt="" draggable={false} /> : <FileText size={14} strokeWidth={1.6} className="vl-icon vl-icon-dim" aria-hidden />}
              <span className="rv-chip-name">{f.name}</span>
              <span className="rv-chip-state">
                {f.state === 'up' ? `${f.size ? Math.min(99, Math.floor((f.sent / f.size) * 100)) : 0}%` : f.state === 'err' ? f.error ?? 'failed' : fmtSize(f.size)}
              </span>
              {f.state === 'err' && f.error !== 'over 50 MB' && f.error !== 'empty' && (
                <Press className="rv-chip-act" onPress={() => draft.retry(f.key)}>Retry</Press>
              )}
              <Press className="rv-chip-x" aria-label={`Remove ${f.name}`} onPress={() => draft.remove(f.key)}>
                <X size={12} strokeWidth={1.8} className="vl-icon vl-icon-dim" aria-hidden />
              </Press>
            </span>
          ))}
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
        <Button kind="line" lit={draft.ready} type="button" className="rv-send" disabled={!draft.ready || sending} onPress={submit}>
          {draft.uploading ? 'Wait' : 'Send'}
        </Button>
      </div>
    </form>
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
  if (vr || NO_FAB.test(pathname)) return null
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
 * a tap outside closes it; what he typed stays for the next time. Mounted
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
    mutationFn: () => sendRaven({ text: draft.text.trim(), files: draft.ids.length ? draft.ids : undefined, source: 'quick' }),
    onSuccess: (m) => {
      setSent(m)
      draft.clear()
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
                  <p className="rv-meta">{[modelLabel(reply.meta.model, reply.meta.tier), reply.meta.effort, etTime(reply.createdAt)].filter(Boolean).join(' · ')}</p>
                </div>
              )
              : <p className="rv-q-wait" data-busy={busy || undefined}>{busy ? status : 'Sent. Raven answers here and in the Raven tab.'}</p>}
          </div>
        )}
        <RavenComposer
          draft={draft}
          sending={send.isPending}
          onSend={() => send.mutate()}
          placeholder={sent ? 'Reply to Raven' : 'Message Raven'}
          taRef={ta}
          className="rv-q-compose"
          maxHeight={140}
        />
      </section>
    </div>,
    document.body,
  )
}
