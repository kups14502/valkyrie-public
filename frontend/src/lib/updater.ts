import { useCallback, useEffect, useRef, useState } from 'react'
import { isTauri, isTauriMobile } from './auth'

// Desktop auto-update (Tauri app only) with a custom, Valkyrie-styled flow:
// check + download the new build in the background (reporting progress), then
// wait. The header alarm shows progress and a "restart to update" button that
// installs (silently on Windows via NSIS passive mode — no MSI dialog) and
// relaunches. We re-check on launch, every 15 min, and whenever the app regains
// focus, so freshly published releases surface without needing a relaunch.
// Best-effort: no-ops on web and swallows errors so a failed/blocked check can
// never block startup.

export type UpdateStatus = 'idle' | 'checking' | 'downloading' | 'ready' | 'installing' | 'error'

const RECHECK_MS = 15 * 60 * 1000

type DownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' }

type TauriUpdate = {
  version: string
  download: (onEvent?: (e: DownloadEvent) => void) => Promise<void>
  install: () => Promise<void>
}

export function useDesktopUpdate(): {
  status: UpdateStatus
  version: string | null
  progress: number
  restart: () => Promise<void>
} {
  const [status, setStatus] = useState<UpdateStatus>('idle')
  const [version, setVersion] = useState<string | null>(null)
  const [progress, setProgress] = useState(0) // 0..1
  const updateRef = useRef<TauriUpdate | null>(null)
  // Mirror status in a ref so the re-check callback can read the latest value
  // without being re-created (and re-subscribing listeners) on every change.
  const statusRef = useRef<UpdateStatus>('idle')
  const setStat = (s: UpdateStatus) => { statusRef.current = s; setStatus(s) }

  const runCheck = useCallback(async () => {
    // Android sideloads its APK; the updater plugin is not registered there.
    if (!isTauri() || isTauriMobile()) return
    // Only look when nothing is already in flight or staged.
    if (statusRef.current !== 'idle' && statusRef.current !== 'error') return
    try {
      setStat('checking')
      const { check } = await import('@tauri-apps/plugin-updater')
      const update = (await check()) as unknown as TauriUpdate | null
      if (!update) { setStat('idle'); return }
      updateRef.current = update
      setVersion(update.version)
      setStat('downloading')
      let total = 0
      let received = 0
      await update.download((e) => {
        if (e.event === 'Started') { total = e.data.contentLength ?? 0; setProgress(0) }
        else if (e.event === 'Progress') { received += e.data.chunkLength; setProgress(total > 0 ? Math.min(1, received / total) : 0) }
        else if (e.event === 'Finished') { setProgress(1) }
      })
      setStat('ready')
    } catch (err) {
      console.warn('[updater] update check failed (non-fatal)', err)
      setStat('error')
    }
  }, [])

  useEffect(() => {
    // Android sideloads its APK; the updater plugin is not registered there.
    if (!isTauri() || isTauriMobile()) return
    void runCheck()
    const interval = setInterval(() => { void runCheck() }, RECHECK_MS)
    const onFocus = () => { void runCheck() }
    const onVisible = () => { if (document.visibilityState === 'visible') void runCheck() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(interval)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [runCheck])

  const restart = async () => {
    if (!updateRef.current) return
    try {
      setStat('installing')
      await updateRef.current.install()
      const { relaunch } = await import('@tauri-apps/plugin-process')
      await relaunch()
    } catch (err) {
      console.warn('[updater] install/relaunch failed', err)
      setStat('error')
    }
  }

  return { status, version, progress, restart }
}
