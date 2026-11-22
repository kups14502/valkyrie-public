// The find bar's arithmetic (kit/find.tsx), kept free of the DOM so e2e/find-unit.mjs runs it in plain node:
// where a query sits in a run of text, which match to start on, stepping with wrap-around, and the Raven tab's
// count, which also holds the lines of the thread it has not loaded yet (the backend's /api/raven/search).

const ESC = /[.*+?^${}()|[\]\\]/g

/** Every start offset of `q` in `text`, case-insensitive, never overlapping. Offsets are into `text` itself. */
export function matchOffsets(text: string, q: string): number[] {
  if (!q || !text) return []
  const re = new RegExp(q.replace(ESC, '\\$&'), 'gi')
  const out: number[] = []
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push(m.index)
    if (m[0].length === 0) re.lastIndex++
  }
  return out
}

/** The next index from `i` among `n` matches, wrapping both ways. -1 when there are none. */
export function stepIndex(i: number, n: number, dir: 1 | -1): number {
  if (n <= 0) return -1
  if (i < 0) return dir === 1 ? 0 : n - 1
  return (((i + dir) % n) + n) % n
}

/**
 * Where a new search starts: the first match at or below the view's top, or with `fromEnd` (the Raven thread,
 * newest at the bottom) the last match above the view's bottom. `tops` are the matches' tops in document order,
 * against the view (0 = its top edge, `height` its bottom). Nothing in or past the view: the nearest one.
 */
export function startIndex(tops: number[], height: number, fromEnd = false): number {
  if (!tops.length) return -1
  if (fromEnd) {
    for (let i = tops.length - 1; i >= 0; i--) if (tops[i] <= height) return i
    return 0
  }
  const i = tops.findIndex((t) => t >= 0)
  return i === -1 ? tops.length - 1 : i
}

export type Hit = { id: number; n: number }

/**
 * The Raven count: matches drawn on screen plus the ones in older lines not loaded yet (they sit above every
 * drawn one). `cur` is the drawn match in focus, -1 for none. `pos` is 1-based, 0 when nothing is in focus.
 */
export function threadCount(hits: Hit[], firstLoaded: number, drawn: number, cur: number): { total: number; pos: number; above: number } {
  const above = hits.reduce((s, h) => (h.id < firstLoaded ? s + h.n : s), 0)
  return { total: above + drawn, pos: cur >= 0 ? above + cur + 1 : 0, above }
}

/** The newest line not loaded yet that holds a match: the one Shift+Enter loads to from the oldest drawn match. */
export function nextOlderHit(hits: Hit[], firstLoaded: number): number | null {
  for (let i = hits.length - 1; i >= 0; i--) if (hits[i].id < firstLoaded) return hits[i].id
  return null
}

/** The oldest line holding a match, for a wrap from the newest match to the very first one. */
export const oldestHit = (hits: Hit[]): number | null => (hits.length ? hits[0].id : null)

/** One word under a point in a text: the run of letters, digits, _ . - @ / around `at`. */
export function wordAt(text: string, at: number): string {
  const w = /[\p{L}\p{N}_.\-@/]/u
  let a = Math.max(0, Math.min(at, text.length))
  let b = a
  while (a > 0 && w.test(text[a - 1])) a--
  while (b < text.length && w.test(text[b])) b++
  return text.slice(a, b).replace(/^[.\-/]+|[.\-/]+$/g, '')
}
