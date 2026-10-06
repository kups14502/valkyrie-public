import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { PROJ_KEYS, waitProjChange } from '../../lib/projectsApi'

const RETRY_MS = 5_000

// Follow a project's rev with the /changes long-poll, so an edit made by a
// session shows on the page in about a second instead of at the next 60 s
// backstop refetch. The server holds each request up to 25 s and answers the
// moment the rev passes the one we sent.
//
// Only while the page is visible. A hidden tab holding a request open is one of
// the browser's six HTTP/1.1 connections to the API spent on nothing. The loop
// resumes on visibilitychange, or on pageshow for a page restored from the
// back-forward cache.
export function useProjectLive(projectId: string, rev: number | undefined): void {
  const qc = useQueryClient()
  const revRef = useRef(rev)
  useEffect(() => { revRef.current = rev }, [rev])
  const started = rev !== undefined

  useEffect(() => {
    if (!started) return
    let alive = true
    let running = false
    let ctl: AbortController | null = null
    let last = revRef.current ?? 0

    const loop = async () => {
      if (running) return
      running = true
      while (alive && document.visibilityState === 'visible') {
        // A doc refetched by other means may already be past us. Starting from
        // the older rev would only earn an instant answer and a refetch of
        // what is already on screen.
        last = Math.max(last, revRef.current ?? 0)
        const mine = new AbortController()
        ctl = mine
        try {
          const r = await waitProjChange(projectId, last, mine.signal)
          if (r.rev > last) {
            last = r.rev
            void qc.invalidateQueries({ queryKey: PROJ_KEYS.doc(projectId) })
            void qc.invalidateQueries({ queryKey: PROJ_KEYS.events(projectId) })
            void qc.invalidateQueries({ queryKey: PROJ_KEYS.list })
          }
        } catch {
          // Aborted means hidden or unmounted, and the loop condition decides
          // which. Anything else is the API being away: back off, try again.
          if (mine.signal.aborted) continue
          await new Promise((r) => setTimeout(r, RETRY_MS))
        }
      }
      running = false
    }

    const wake = () => {
      if (document.visibilityState === 'visible') void loop()
      else ctl?.abort()
    }
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('pageshow', wake)
    void loop()
    return () => {
      alive = false
      ctl?.abort()
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('pageshow', wake)
    }
  }, [projectId, started, qc])
}
