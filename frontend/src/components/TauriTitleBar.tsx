import { useEffect, useState, type ReactNode } from 'react'
import { Minus, Square, Copy, X } from 'lucide-react'
import { isTauri } from '../lib/auth'

// Window controls (minimize / maximize / close) for the frameless Tauri window.
// Absolutely positioned flush against the header's top-right corner (see App.tsx,
// rendered as a sibling outside the header's padded content row) so the close
// button sits exactly at the window corner, like a native title bar. The header
// itself is the draggable title bar (see App.tsx data-tauri-drag-region), so
// there's no separate title strip. Returns null on web (the browser/PWA keeps
// its chrome).

type AppWindow = {
  minimize: () => Promise<void>
  toggleMaximize: () => Promise<void>
  close: () => Promise<void>
  isMaximized: () => Promise<boolean>
  onResized: (cb: () => void) => Promise<() => void>
}

export function WindowControls() {
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
    <div className="absolute right-0 top-0 flex h-full items-stretch">
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
      className={`flex h-full w-11 items-center justify-center text-[var(--color-text-dim)] transition-colors ${
        danger
          ? 'hover:bg-[var(--color-danger)] hover:text-white'
          : 'hover:bg-[rgba(255,255,255,0.08)] hover:text-[var(--color-text)]'
      }`}
    >
      {children}
    </button>
  )
}
