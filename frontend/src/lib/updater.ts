import { isTauri } from './auth'

// Desktop auto-update. On launch (in the Tauri app only) check the update
// endpoint; if a newer signed build exists, download + install it and relaunch.
// Best-effort: no-ops on web and swallows all errors so a failed/blocked update
// check can never prevent the app from starting.
export async function runUpdateCheck(): Promise<void> {
  if (!isTauri()) return
  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    const update = await check()
    if (!update) return
    await update.downloadAndInstall()
    const { relaunch } = await import('@tauri-apps/plugin-process')
    await relaunch()
  } catch (err) {
    console.warn('[updater] update check failed (non-fatal)', err)
  }
}
