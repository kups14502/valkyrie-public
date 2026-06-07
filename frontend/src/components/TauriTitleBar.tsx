import { useEffect, useState, type ReactNode } from 'react'
import { Minus, Square, Copy, X } from 'lucide-react'
import { isTauri } from '../lib/auth'

// On-brand custom title bar for the frameless Tauri window (decorations:false).
// Replaces the native OS title bar: a draggable strip with the BRNDN//SYS_ mark
// on the left and themed minimize / maximize / close controls on the right.
// Renders only inside the app — on web it returns null (the PWA uses TitleBar).

type AppWindow = {
  minimize: () => Promise<void>
  toggleMaximize: () => Promise<void>
  close: () => Promise<void>
  isMaximized: () => Promise<boolean>
  onResized: (cb: () => void) => Promise<() => void>
}

export function TauriTitleBar() {
  const [win, setWin] = useState<AppWindow | null>(null)
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (!isTauri()) return
    let unlisten: (() => void) | undefined
    void import('@tauri-apps/api/window')
      .then(async ({ getCurrentWindow }) => {
        const w = getCurrentWindow() as unknown as AppWindow
        setWin(w)
        setMaximized(await w.isMaximized())
        unlisten = await w.onResized(async () => setMaximized(await w.isMaximized()))
      })
      .catch(() => {})
    return () => unlisten?.()
  }, [])

  if (!isTauri()) return null

  return (
    <div
      data-tauri-drag-region
      className="fixed inset-x-0 top-0 z-[200] flex h-[var(--titlebar-h)] select-none items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-bg)] pl-3"
    >
      <div
        data-tauri-drag-region
        className="pointer-events-none flex items-center gap-0.5 text-[10px] font-bold uppercase tracking-[0.28em]"
        style={{ color: 'var(--color-accent)', textShadow: '0 0 8px var(--color-accent)' }}
      >
        BRNDN<span className="opacity-40">//</span>SYS<span className="cursor-blink">_</span>
        <span className="ml-3 tracking-[0.2em] text-[var(--color-text-faint)]">MASTER CONTROL</span>
      </div>
      <div className="flex h-full">
        <TitleButton label="Minimize" onClick={() => win?.minimize()}>
          <Minus size={14} />
        </TitleButton>
        <TitleButton label="Maximize" onClick={() => win?.toggleMaximize()}>
          {maximized ? <Copy size={11} /> : <Square size={11} />}
        </TitleButton>
        <TitleButton label="Close" danger onClick={() => win?.close()}>
          <X size={15} />
        </TitleButton>
      </div>
    </div>
  )
}

function TitleButton({ children, onClick, label, danger }: {
  children: ReactNode
  onClick: () => void
  label: string
  danger?: boolean
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={`flex h-full w-[46px] items-center justify-center text-[var(--color-text-dim)] transition-colors ${
        danger
          ? 'hover:bg-[var(--color-danger)] hover:text-white'
          : 'hover:bg-[rgba(255,255,255,0.08)] hover:text-[var(--color-text)]'
      }`}
    >
      {children}
    </button>
  )
}
