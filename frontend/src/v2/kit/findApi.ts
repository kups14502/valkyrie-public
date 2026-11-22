import { useEffect, useLayoutEffect, useRef } from 'react'
import type { Hit } from './findCore'

// The find bar's doors (kit/find.tsx draws it): openFind for the context menu's Find, and the provider a screen
// lends it so the count and the steps reach what the screen has not drawn yet (the Raven thread's older lines).

export type FindProvider = {
  /** the element the find runs in */
  root: () => HTMLElement | null
  /** start on the newest match, at the bottom (a thread), instead of the first one in view */
  fromEnd?: boolean
  /** the lines past what is drawn that hold the words, oldest first */
  search?: (q: string) => Promise<Hit[]>
  /** the oldest line drawn */
  firstLoaded?: () => number
  /** load the thread back to line `id`; resolves once it is asked for (the bar waits for the line to draw) */
  reveal?: (id: number) => Promise<void>
  /** line `id` as drawn */
  lineEl?: (id: number) => Element | null
}

export const findProviders: { p: FindProvider }[] = []

/** Lend the find bar a provider while `on` (the screen is in front). The newest one wins. */
export function useFindProvider(p: FindProvider, on: boolean): void {
  const ref = useRef(p)
  useLayoutEffect(() => { ref.current = p })
  useEffect(() => {
    if (!on) return
    const entry = {
      p: {
        root: () => ref.current.root(),
        get fromEnd() { return ref.current.fromEnd },
        search: ref.current.search && ((q: string) => ref.current.search!(q)),
        firstLoaded: ref.current.firstLoaded && (() => ref.current.firstLoaded!()),
        reveal: ref.current.reveal && ((id: number) => ref.current.reveal!(id)),
        lineEl: ref.current.lineEl && ((id: number) => ref.current.lineEl!(id)),
      } as FindProvider,
    }
    findProviders.push(entry)
    return () => {
      const i = findProviders.indexOf(entry)
      if (i !== -1) findProviders.splice(i, 1)
    }
  }, [on])
}

export const FIND_EVENT = 'v2-find-open'

/** Open the find bar, with `q` in its box when given (the context menu's "Find"). */
export function openFind(q?: string): void {
  window.dispatchEvent(new CustomEvent(FIND_EVENT, { detail: q ?? null }))
}
