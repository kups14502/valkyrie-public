import { useEffect } from 'react'

/**
 * A file dropped where nothing takes it (anywhere but the Raven tab, its box and the upload blocks) is refused, with
 * the no-drop cursor on the way: the browser would otherwise open it in place of the app. A screen that takes files
 * calls preventDefault on dragover and drop first, which this leaves alone.
 */
export function useDropGuard(): void {
  useEffect(() => {
    const files = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')
    const over = (e: DragEvent) => {
      if (!files(e) || e.defaultPrevented) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
    }
    const drop = (e: DragEvent) => {
      if (files(e) && !e.defaultPrevented) e.preventDefault()
    }
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [])
}
