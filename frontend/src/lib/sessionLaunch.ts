import type { QueryClient } from '@tanstack/react-query'
import { isTauri, isTauriMobile } from './auth'
import type { TermSession } from './api'

// Where "open" puts a session. In a browser there is only one answer: the page.
// The desktop app can do either, and until now it could ONLY open a window on
// the local screen, so an in-page terminal was reachable from the desktop app
// only when one already existed and could be clicked in the "in page" row.
// Shared by the session board's toggle and the dashboards' quick-start row.
export type OpenMode = 'page' | 'screen'
export const OPEN_MODE_KEY = 'valkyrie-session-open-mode'

export const readOpenMode = (): OpenMode => {
  // The Android app has no local terminal to open either.
  if (!isTauri() || isTauriMobile()) return 'page'
  try {
    return localStorage.getItem(OPEN_MODE_KEY) === 'page' ? 'page' : 'screen'
  } catch {
    return 'screen'
  }
}

// Put the session we just created into the terminal page's cache BEFORE
// navigating to it.
//
// Without this the handoff picks the wrong session. The board's OpenTerminals
// keeps ['term','sessions'] warm, so the terminal page mounts, renders that
// cached list synchronously (and, inside the 10s global staleTime, may not
// refetch at all), fails to find the brand-new name from ?s= in it, and falls
// back to the old list's first row: the phone ends up attached to the previous
// session while the one just launched sits unselected. POST /terminal/sessions
// already returns the row, so seeding is exact; if it somehow came back without
// one, invalidating makes the page refetch and its own guard covers the gap.
// Here rather than in SessionBoard because the project page and the dashboards
// open panes outside the board and have the same handoff race.
export function seedTerminal(qc: QueryClient, r: { name: string; session: TermSession | null }): void {
  if (!r.session) {
    void qc.invalidateQueries({ queryKey: ['term', 'sessions'] })
    return
  }
  const fresh = r.session
  qc.setQueryData<TermSession[]>(['term', 'sessions'], (old) => [fresh, ...(old ?? []).filter((s) => s.name !== fresh.name)])
}
