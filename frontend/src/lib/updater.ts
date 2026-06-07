import { useEffect, useRef, useState } from 'react'
import { isTauri } from './auth'

// Desktop auto-update (Tauri app only) with a custom, Valkyrie-styled flow:
// on launch we check + download the new build in the background (reporting
// progress), then wait. The header alarm shows progress and a "restart to
// update" button; clicking it installs (silently on Windows via NSIS passive
// mode — no MSI dialog) and relaunches. Best-effort: no-ops on web and swallows
// errors so a failed/blocked check never blocks startup.

export type UpdateStatus = 'idle' | 'checking' | 'downloading' | 'ready' | 'installing' | 'error'

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

  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    void (async () => {
      try {
        setStatus('checking')
        const { check } = await import('@tauri-apps/plugin-updater')
        const update = (await check()) as unknown as TauriUpdate | null
        if (!update) { if (!cancelled) setStatus('idle'); return }
        if (cancelled) return
        updateRef.current = update
        setVersion(update.version)
        setStatus('downloading')
        let total = 0
        let received = 0
        await update.download((e) => {
          if (cancelled) return
          if (e.event === 'Started') { total = e.data.contentLength ?? 0; setProgress(0) }
          else if (e.event === 'Progress') { received += e.data.chunkLength; setProgress(total > 0 ? Math.min(1, received / total) : 0) }
          else if (e.event === 'Finished') { setProgress(1) }
        })
        if (!cancelled) setStatus('ready')
      } catch (err) {
        console.warn('[updater] update check failed (non-fatal)', err)
        if (!cancelled) setStatus('error')
      }
    })()
    return () => { cancelled = true }
  }, [])

  const restart = async () => {
    if (!updateRef.current) return
    try {
      setStatus('installing')
      await updateRef.current.install()
      const { relaunch } = await import('@tauri-apps/plugin-process')
      await relaunch()
    } catch (err) {
      console.warn('[updater] install/relaunch failed', err)
      setStatus('error')
    }
  }

  return { status, version, progress, restart }
}
