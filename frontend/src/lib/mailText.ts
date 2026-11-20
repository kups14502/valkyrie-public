// A mail body (plain text, backend lib/mailStore.ts) split into what the sender wrote and what
// only rides along with it, so the inbox shows the first and folds the rest behind "Show quoted
// text":
//   * a help desk's "##- Please type your reply above this line -##" marker with the rules and
//     blank lines around it (Zendesk puts it at the top of every reply), and its footer: a rule,
//     a line or two and a tracking tag like [AB12CD-EF34G] at the very end;
//   * the earlier messages a reply quotes, from the first of these to the end: an "On <date>,
//     <name> wrote:" line, an Outlook header block (From: with Sent:, Date:, To: or Subject:
//     under it), an "Original Message" or "Forwarded message" line, or a run of "> " lines that
//     ends the message.
// The sender's part is never empty: a quote with nothing of the sender's above it (a forward)
// does not fold, and a body that would fold entirely comes back whole.

export type MailPart = { text: string; quoted: boolean }

const MARKER_RE = /reply above this line/i
const RULE_RE = /^[\s\-=_*~#.]{6,}$/
const WROTE_RE = /^On\s.{4,240}\swrote:$/i
const FORWARD_RE = /^[-_\s]*(original message|forwarded message|begin forwarded message:?)[-_\s]*$/i
const HEADER_FROM_RE = /^\*?From:\*?\s+\S/i
const HEADER_NEXT_RE = /^\*?(Sent|Date|To|Cc|Subject):\*?\s/i
const TAG_RE = /^\[[A-Z0-9]{4,10}-[A-Z0-9]{4,10}\]$/

const trimBlank = (ls: string[]): string => {
  let a = 0
  let b = ls.length
  while (a < b && !ls[a].trim()) a++
  while (b > a && !ls[b - 1].trim()) b--
  return ls.slice(a, b).join('\n')
}

export function splitQuoted(body: string): MailPart[] {
  const lines = body.replace(/\r\n?/g, '\n').split('\n')
  const n = lines.length
  const hide: boolean[] = new Array(n).fill(false)
  const line = (i: number) => lines[i].trim()
  const blank = (i: number) => !line(i)
  const rule = (i: number) => RULE_RE.test(lines[i])

  // the help desk's marker, with the blank lines and rules on either side of it
  for (let i = 0; i < n; i++) {
    if (lines[i].length > 100 || !MARKER_RE.test(lines[i])) continue
    hide[i] = true
    for (let j = i + 1; j < n && (blank(j) || rule(j)); j++) hide[j] = true
    for (let j = i - 1; j >= 0 && (blank(j) || rule(j)); j--) hide[j] = true
  }

  // its footer: the last line a tracking tag, from the rule at most five lines above it
  let last = n - 1
  while (last >= 0 && blank(last)) last--
  if (last >= 0 && TAG_RE.test(line(last))) {
    let j = last - 1
    let seen = 0
    while (j >= 0 && !rule(j) && seen < 5) {
      if (!blank(j)) seen++
      j--
    }
    for (let x = j >= 0 && rule(j) ? j : last; x < n; x++) hide[x] = true
  }

  const quoteStart = (i: number): boolean => {
    const l = line(i)
    if (WROTE_RE.test(l) || FORWARD_RE.test(l)) return true
    // "On Mon, Nov 16, 2026 at 10:00 AM Pat Example <" carries its "wrote:" to the next line
    if (/^On\s/i.test(l) && i + 1 < n && WROTE_RE.test(`${l} ${line(i + 1)}`)) return true
    if (HEADER_FROM_RE.test(l)) {
      let heads = 0
      for (let j = i + 1; j < Math.min(n, i + 6); j++) if (HEADER_NEXT_RE.test(line(j))) heads++
      return heads >= 2
    }
    if (l.startsWith('>')) {
      for (let j = i + 1; j < n; j++) if (line(j) && !line(j).startsWith('>')) return false
      return true
    }
    return false
  }

  // the quoted messages: the first quote start with something of the sender's above it folds to the end
  let own = false
  for (let i = 0; i < n; i++) {
    if (hide[i] || blank(i)) continue
    if (quoteStart(i)) {
      if (!own) break
      for (let x = i; x < n; x++) hide[x] = true
      for (let x = i - 1; x >= 0 && !hide[x] && (blank(x) || rule(x)); x--) hide[x] = true
      break
    }
    if (!rule(i)) own = true
  }

  const parts: MailPart[] = []
  for (let i = 0; i < n;) {
    let j = i
    while (j < n && hide[j] === hide[i]) j++
    const text = trimBlank(lines.slice(i, j))
    if (text) parts.push({ text, quoted: hide[i] })
    i = j
  }
  return parts.some((p) => !p.quoted) ? parts : [{ text: body.trim(), quoted: false }]
}
