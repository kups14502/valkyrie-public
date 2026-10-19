// The Chat view's footer, read off the pane's screen (the transcript has none
// of it): the spinner line while Claude works ("✻ Cogitating… (23s · ↓ 1.2k
// tokens · esc to interrupt)"), the context warning Claude Code prints under
// its prompt, and the status line's usage meters ("5h 23%", "wk 41%").

export type Foot = {
  /** the spinner's word ("Cogitating"), while one is on screen */
  verb: string | null
  /** what the spinner says beside it: elapsed time, tokens */
  detail: string | null
  /** context left before auto-compact, in percent */
  ctx: number | null
  /** the usage windows from the status line, in percent used */
  five: number | null
  week: number | null
}

export const NO_FOOT: Foot = { verb: null, detail: null, ctx: null, five: null, week: null }

const SPIN = /^\s*[·✢✳✶✻✽*]\s+([^\s…][^…]{0,40}?)…\s*(?:\((.*)\))?/
const NOISE = /esc to interrupt|ctrl\+|to (?:show|hide)|shift\+/i
const CTX = [
  /Context left until auto-compact:\s*(\d{1,3})%/i,
  /(\d{1,3})%\s+context left/i,
  /Context low \((\d{1,3})% remaining\)/i,
]

const pct = (re: RegExp, s: string): number | null => {
  const m = re.exec(s)
  if (!m) return null
  const n = Number(m[1])
  return n >= 0 && n <= 100 ? n : null
}

/** The footer facts from the bottom rows of the screen (screenLines). */
export function readFoot(lines: string[]): Foot {
  const tail = lines.slice(-16)
  let verb: string | null = null
  let detail: string | null = null
  for (const l of tail) {
    const m = SPIN.exec(l)
    if (!m) continue
    verb = m[1].trim()
    const parts = (m[2] ?? '').split('·').map((p) => p.trim()).filter((p) => p && !NOISE.test(p))
    detail = parts.slice(0, 2).join(' · ').replace(/\btokens\b/, 'tok') || null
  }
  const foot = lines.slice(-6).join('  ')
  let ctx: number | null = null
  for (const re of CTX) {
    ctx = pct(re, foot)
    if (ctx !== null) break
  }
  return { verb, detail, ctx, five: pct(/\b5h\s+(\d{1,3})%/, foot), week: pct(/\bwk\s+(\d{1,3})%/, foot) }
}

export const sameFoot = (a: Foot, b: Foot) =>
  a.verb === b.verb && a.detail === b.detail && a.ctx === b.ctx && a.five === b.five && a.week === b.week
