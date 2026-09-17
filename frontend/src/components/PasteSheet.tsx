import { useEffect, useRef } from 'react'
import { TERM_FONT_FAMILY } from '../lib/term'

// The paste of last resort, for every screen that talks to a pty.
//
// navigator.clipboard.readText() exists only in a secure context, and on the
// tailnet the app is served over plain http (see lib/buildCheck.ts), so on the
// phone and in the headset navigator.clipboard is undefined and the old
// execCommand trick has no read counterpart. The one paste left is the one the
// OS performs itself: show a field, let the long-press menu fill it, send what
// lands there. Nothing here reads the clipboard, which is exactly why it works.
//
// Positioned absolutely, so it must be rendered inside a positioned box. On the
// terminal page that is the stage, whose size no page state can change, so
// opening this costs no refit and no tmux repaint.

type Props = {
  onSend: (text: string) => void
  onClose: () => void
}

const BTN = 'inline-flex min-h-10 items-center justify-center gap-1.5 border border-[var(--color-border)] px-3 text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-dim)] transition-colors active:border-[var(--color-accent)] active:text-[var(--color-accent)] hover:border-[var(--color-accent)]/50'

export function PasteSheet({ onSend, onClose }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null)

  // Focused on mount so the long-press menu is one press away. iOS pinch-zooms
  // the layout whenever a focused control is under 16px, so the field stays at
  // 16px however small the terminal font is.
  useEffect(() => { ref.current?.focus() }, [])

  const send = () => {
    const v = ref.current?.value ?? ''
    onClose()
    if (v) onSend(v)
  }

  return (
    <div className="absolute inset-0 z-50 flex flex-col gap-2 bg-black/92 p-3">
      <div className="text-[10px] uppercase tracking-[0.24em] text-[var(--color-text-faint)]">
        &gt; long-press the box, paste, then send
      </div>
      <textarea
        ref={ref}
        rows={4}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        className="w-full flex-1 resize-none border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]/60"
        style={{ fontFamily: TERM_FONT_FAMILY, fontSize: 16 }}
      />
      <div className="flex shrink-0 items-center gap-2">
        <button type="button" onClick={send} className={BTN}>send</button>
        <button type="button" onClick={onClose} className={BTN}>cancel</button>
      </div>
    </div>
  )
}
