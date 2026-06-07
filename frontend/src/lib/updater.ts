import { useEffect, useState } from 'react'
import { isTauri } from './auth'

// Desktop auto-update (Tauri app only). On launch we check the update endpoint
// and, if a newer signed build exists, download + stage it in the background —
// but we DON'T relaunch automatically. Instead we surface a "ready" state so the
// header can show an alarm the user clicks to restart on their own schedule.
// Best-effort: no-ops on web and swallows all errors so a failed/blocked update
// check can never prevent the app from starting.

export type UpdateStatus = 'idle' | 'checking' | 'downloading' | 'ready' | 'error'

export function useDesktopUpdate(): { status: UpdateStatus; version: string | null; restart: () => Promise<void> } {
  const [status, setStatus] = useState<UpdateStatus>('idle')
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    void (async () => {
      try {
        setStatus('checking')
        const { check } = await import('@tauri-apps/plugin-updater')
        const update = await check()
        if (!update) { if (!cancelled) setStatus('idle'); return }
        if (!cancelled) { setVersion(update.version); setStatus('downloading') }
        // Download + stage the update now so the restart is instant.
        await update.downloadAndInstall()
        if (!cancelled) setStatus('ready')
      } catch (err) {
        console.warn('[updater] update check failed (non-fatal)', err)
        if (!cancelled) setStatus('error')
      }
    })()
    return () => { cancelled = true }
  }, [])

  const restart = async () => {
    try {
      const { relaunch } = await import('@tauri-apps/plugin-process')
      await relaunch()
    } catch (err) {
      console.warn('[updater] relaunch failed', err)
    }
  }

  return { status, version, restart }
}
