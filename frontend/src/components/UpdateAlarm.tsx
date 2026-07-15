import { Download, RefreshCw } from 'lucide-react'
import { useDesktopUpdate } from '../lib/updater'
import { useWebUpdate } from '../lib/pwaUpdate'

// Header update control, styled to match Valkyrie (no native Windows installer
// dialog — the install runs silently and all UX lives here).
// The download runs in the background with a small progress chip; once staged,
// a single click installs and relaunches (desktop) or reloads (web). No bell,
// no dropdown, one press.
export function UpdateAlarm() {
  const { status, version, progress, restart } = useDesktopUpdate()
  const { needRefresh, reload } = useWebUpdate()

  const downloading = status === 'downloading'
  const installing = status === 'installing'
  const desktopReady = status === 'ready'
  if (!(downloading || installing || desktopReady || needRefresh)) return null

  if (downloading || installing) {
    const pct = Math.round(progress * 100)
    return (
      <div
        className="pointer-events-auto flex h-8 items-center gap-2 border border-[var(--color-border)] px-2.5 text-[10px] uppercase tracking-[0.12em] text-[var(--color-text-dim)]"
        title={installing ? 'Installing update' : `Downloading v${version ?? ''}`}
      >
        {installing
          ? <RefreshCw size={13} className="animate-spin text-[var(--color-accent)]" />
          : <Download size={13} className="text-[var(--color-accent)]" />}
        {installing ? 'installing…' : `${version ? `v${version}` : 'update'} ${pct}%`}
      </div>
    )
  }

  // Ready: one click installs + relaunches (desktop) or reloads (web).
  const onAct = desktopReady ? () => { void restart() } : () => reload()
  return (
    <button
      type="button"
      onClick={onAct}
      title={desktopReady ? `Install v${version ?? ''} and restart` : 'Reload to update'}
      className="pointer-events-auto flex h-8 animate-pulse items-center gap-2 border border-[var(--color-accent)] px-2.5 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--color-accent)] transition hover:bg-[rgba(var(--color-accent-rgb),0.1)]"
      style={{ boxShadow: '0 0 10px var(--color-accent)' }}
    >
      <RefreshCw size={13} /> update{version ? ` v${version}` : ''}
    </button>
  )
}
