// Minimal iCalendar (RFC 5545) reader: enough of it to render a real Outlook
// or Google calendar feed, and nothing more.
//
// Deliberately dependency-free. The parts that actually matter for a work
// calendar are line unfolding, TZID-qualified local times, and recurrence, so
// those are implemented; VALARM, VTODO, VFREEBUSY, attendee lists and the
// stranger BY* rule parts are read past.

export type IcsEvent = {
  uid: string
  summary: string
  location: string
  description: string
  organizer: string
  status: string
  /** ISO instant. For an all-day event this is midnight in the feed's zone. */
  start: string
  end: string
  allDay: boolean
  recurring: boolean
  url: string
}

type Prop = { name: string; params: Record<string, string>; value: string }
type Component = { name: string; props: Prop[]; children: Component[] }

/** RFC 5545 §3.1: a leading space or tab continues the previous line. */
function unfold(text: string): string[] {
  const out: string[] = []
  for (const raw of text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
    if ((raw.startsWith(' ') || raw.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += raw.slice(1)
    } else if (raw.length > 0) {
      out.push(raw)
    }
  }
  return out
}

/** Split at the first colon that is not inside a quoted parameter value. */
function parseLine(line: string): Prop | null {
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') inQuotes = !inQuotes
    else if (ch === ':' && !inQuotes) {
      const head = line.slice(0, i)
      const value = line.slice(i + 1)
      const segments: string[] = []
      let cur = ''
      let q = false
      for (const c of head) {
        if (c === '"') { q = !q; continue }
        if (c === ';' && !q) { segments.push(cur); cur = ''; continue }
        cur += c
      }
      segments.push(cur)
      const name = (segments.shift() || '').toUpperCase()
      const params: Record<string, string> = {}
      for (const seg of segments) {
        const eq = seg.indexOf('=')
        if (eq > 0) params[seg.slice(0, eq).toUpperCase()] = seg.slice(eq + 1)
      }
      return { name, params, value }
    }
  }
  return null
}

function parseComponents(text: string): Component {
  const root: Component = { name: 'ROOT', props: [], children: [] }
  const stack: Component[] = [root]
  for (const line of unfold(text)) {
    const prop = parseLine(line)
    if (!prop) continue
    if (prop.name === 'BEGIN') {
      const child: Component = { name: prop.value.toUpperCase(), props: [], children: [] }
      stack[stack.length - 1].children.push(child)
      stack.push(child)
    } else if (prop.name === 'END') {
      if (stack.length > 1) stack.pop()
    } else {
      stack[stack.length - 1].props.push(prop)
    }
  }
  return root
}

function unescapeText(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
}

// Outlook desktop writes Windows zone names into TZID, which Intl rejects.
// Only the zones a US-based calendar realistically carries are mapped; an
// unknown name falls back to the feed's default zone.
const WINDOWS_ZONES: Record<string, string> = {
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'US Mountain Standard Time': 'America/Phoenix',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Atlantic Standard Time': 'America/Halifax',
  'GMT Standard Time': 'Europe/London',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Budapest',
  'India Standard Time': 'Asia/Kolkata',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'UTC': 'UTC',
}

const formatters = new Map<string, Intl.DateTimeFormat>()
function formatterFor(tz: string): Intl.DateTimeFormat | null {
  const hit = formatters.get(tz)
  if (hit) return hit
  try {
    const f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    formatters.set(tz, f)
    return f
  } catch {
    return null
  }
}

function zoneOffsetMs(utcMs: number, tz: string): number {
  const f = formatterFor(tz)
  if (!f) return 0
  const parts: Record<string, number> = {}
  for (const p of f.formatToParts(new Date(utcMs))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value)
  }
  const asUtc = Date.UTC(parts.year, (parts.month || 1) - 1, parts.day || 1, parts.hour || 0, parts.minute || 0, parts.second || 0)
  return asUtc - utcMs
}

/**
 * Turn a wall-clock instant (the local fields packed with Date.UTC) into the
 * real UTC instant it names in `tz`. Two passes, because the offset itself
 * depends on the answer: the first guess lands within an hour, the second
 * settles it, including across a DST boundary.
 */
function wallToUtc(wallMs: number, tz: string): number {
  const first = wallMs - zoneOffsetMs(wallMs, tz)
  return wallMs - zoneOffsetMs(first, tz)
}

type IcsDate = { wallMs: number; tz: string | null; dateOnly: boolean }

/** DTSTART/DTEND/EXDATE value: a UTC instant, a zoned local time, or a date. */
function parseDate(prop: Prop, defaultTz: string): IcsDate | null {
  const raw = prop.value.trim()
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(raw)
  if (!m) return null
  const [, y, mo, d, h, mi, s, z] = m
  const wallMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h || 0), Number(mi || 0), Number(s || 0))
  if (!h) return { wallMs, tz: defaultTz, dateOnly: true }
  if (z) return { wallMs, tz: null, dateOnly: false }
  const tzid = prop.params.TZID
  const tz = tzid ? (WINDOWS_ZONES[tzid] || (formatterFor(tzid) ? tzid : defaultTz)) : defaultTz
  return { wallMs, tz, dateOnly: false }
}

const toInstant = (d: IcsDate): number => (d.tz ? wallToUtc(d.wallMs, d.tz) : d.wallMs)

type Rrule = {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
  interval: number
  count: number | null
  untilMs: number | null
  byDay: { ordinal: number; weekday: number }[]
  byMonthDay: number[]
  byMonth: number[]
}

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

function parseRrule(value: string, tz: string | null): Rrule | null {
  const parts: Record<string, string> = {}
  for (const seg of value.split(';')) {
    const eq = seg.indexOf('=')
    if (eq > 0) parts[seg.slice(0, eq).toUpperCase()] = seg.slice(eq + 1)
  }
  const freq = (parts.FREQ || '').toUpperCase()
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') return null
  let untilMs: number | null = null
  if (parts.UNTIL) {
    const parsed = parseDate({ name: 'UNTIL', params: {}, value: parts.UNTIL }, tz || 'UTC')
    if (parsed) untilMs = toInstant(parsed)
  }
  const byDay = (parts.BYDAY || '')
    .split(',')
    .map((token) => /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(token.trim()))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .map((m) => ({ ordinal: Number(m[1] || 0), weekday: WEEKDAYS.indexOf(m[2].toUpperCase()) }))
  const numbers = (key: string) => (parts[key] || '')
    .split(',')
    .map((n) => Number(n.trim()))
    .filter((n) => Number.isFinite(n) && n !== 0)
  return {
    freq,
    interval: Math.max(1, Number(parts.INTERVAL) || 1),
    count: parts.COUNT ? Number(parts.COUNT) : null,
    untilMs,
    byDay,
    byMonthDay: numbers('BYMONTHDAY'),
    byMonth: numbers('BYMONTH'),
  }
}

const DAY_MS = 86_400_000
const dayOf = (wallMs: number) => new Date(wallMs).getUTCDay()

/** Every day in [from, to] of the given month whose weekday matches a BYDAY. */
function monthlyDays(year: number, month: number, rule: Rrule, seedDay: number): number[] {
  const first = Date.UTC(year, month, 1)
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  if (rule.byMonthDay.length > 0) {
    return rule.byMonthDay
      .map((n) => (n > 0 ? n : days + 1 + n))
      .filter((n) => n >= 1 && n <= days)
  }
  if (rule.byDay.length === 0) return seedDay <= days ? [seedDay] : []
  const out = new Set<number>()
  for (const { ordinal, weekday } of rule.byDay) {
    const matches: number[] = []
    for (let d = 1; d <= days; d++) {
      if (dayOf(first + (d - 1) * DAY_MS) === weekday) matches.push(d)
    }
    if (ordinal === 0) matches.forEach((d) => out.add(d))
    else {
      const pick = ordinal > 0 ? matches[ordinal - 1] : matches[matches.length + ordinal]
      if (pick) out.add(pick)
    }
  }
  return [...out].sort((a, b) => a - b)
}

/**
 * Expand a recurrence into wall-clock starts that overlap [fromMs, toMs].
 *
 * Iteration happens in wall-clock space and each hit is converted to a real
 * instant separately, so a weekly 9am meeting stays 9am across a DST change
 * instead of drifting an hour.
 */
function expand(startWall: number, rule: Rrule, tz: string | null, fromMs: number, toMs: number, durationMs: number): number[] {
  const out: number[] = []
  const seed = new Date(startWall)
  const seedTime = startWall - Date.UTC(seed.getUTCFullYear(), seed.getUTCMonth(), seed.getUTCDate())
  const seedDay = seed.getUTCDate()
  // A generous ceiling: the window is a month or two, so this only ever runs
  // away on a malformed rule.
  const MAX_ITERATIONS = 5000
  let emitted = 0

  const consider = (wallMs: number): boolean => {
    if (rule.count != null && emitted >= rule.count) return false
    const instant = tz ? wallToUtc(wallMs, tz) : wallMs
    if (rule.untilMs != null && instant > rule.untilMs) return false
    emitted++
    if (instant + durationMs > fromMs && instant < toMs) out.push(wallMs)
    return true
  }

  if (rule.freq === 'DAILY' || rule.freq === 'WEEKLY') {
    const stepDays = rule.freq === 'DAILY' ? rule.interval : rule.interval * 7
    // For WEEKLY;BYDAY the cursor walks week starts and each listed weekday in
    // that week is a candidate.
    const weekdays = rule.freq === 'WEEKLY' && rule.byDay.length > 0
      ? rule.byDay.map((b) => b.weekday)
      : [dayOf(startWall)]
    const seedMidnight = startWall - seedTime
    const weekStart = seedMidnight - dayOf(startWall) * DAY_MS
    let cursor = rule.freq === 'DAILY' ? seedMidnight : weekStart
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      if (rule.freq === 'DAILY') {
        if (cursor >= seedMidnight && !consider(cursor + seedTime)) break
      } else {
        let stop = false
        for (const wd of weekdays.slice().sort((a, b) => a - b)) {
          const day = cursor + wd * DAY_MS
          if (day < seedMidnight) continue
          if (!consider(day + seedTime)) { stop = true; break }
        }
        if (stop) break
      }
      cursor += stepDays * DAY_MS
      if (cursor > toMs + 400 * DAY_MS) break
    }
    return out
  }

  // MONTHLY and YEARLY both walk months; YEARLY just steps twelve at a time
  // and honors BYMONTH.
  const stepMonths = rule.freq === 'MONTHLY' ? rule.interval : rule.interval * 12
  let year = seed.getUTCFullYear()
  let month = seed.getUTCMonth()
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const months = rule.freq === 'YEARLY' && rule.byMonth.length > 0
      ? rule.byMonth.map((m) => m - 1)
      : [month]
    let stop = false
    for (const m of months) {
      for (const d of monthlyDays(year, m, rule, seedDay)) {
        const wall = Date.UTC(year, m, d) + seedTime
        if (wall < startWall) continue
        if (!consider(wall)) { stop = true; break }
      }
      if (stop) break
    }
    if (stop) break
    month += stepMonths
    year += Math.floor(month / 12)
    month = ((month % 12) + 12) % 12
    if (Date.UTC(year, month, 1) > toMs + 400 * DAY_MS) break
  }
  return out
}

const firstProp = (c: Component, name: string): Prop | undefined => c.props.find((p) => p.name === name)
const propValue = (c: Component, name: string): string => unescapeText(firstProp(c, name)?.value ?? '').trim()

/**
 * Parse an ICS document and return every event instance that overlaps the
 * window, recurrences expanded and RECURRENCE-ID overrides applied.
 */
export function parseIcs(text: string, fromMs: number, toMs: number, defaultTz: string): IcsEvent[] {
  const root = parseComponents(text)
  const calendar = root.children.find((c) => c.name === 'VCALENDAR') ?? root
  const feedTz = (() => {
    const raw = propValue(calendar, 'X-WR-TIMEZONE')
    if (!raw) return defaultTz
    return WINDOWS_ZONES[raw] || (formatterFor(raw) ? raw : defaultTz)
  })()

  const vevents = calendar.children.filter((c) => c.name === 'VEVENT')
  // An instance-level override (a single moved or edited occurrence) carries
  // RECURRENCE-ID; keyed by uid + that instant so it can replace the generated
  // occurrence rather than showing up beside it.
  const overrides = new Map<string, Component>()
  for (const ev of vevents) {
    const rid = firstProp(ev, 'RECURRENCE-ID')
    const uid = propValue(ev, 'UID')
    if (rid && uid) {
      const parsed = parseDate(rid, feedTz)
      if (parsed) overrides.set(`${uid}@${toInstant(parsed)}`, ev)
    }
  }

  const out: IcsEvent[] = []
  const emit = (ev: Component, startMs: number, endMs: number, allDay: boolean, recurring: boolean) => {
    const status = propValue(ev, 'STATUS').toUpperCase()
    if (status === 'CANCELLED') return
    out.push({
      uid: propValue(ev, 'UID') || `${startMs}`,
      summary: propValue(ev, 'SUMMARY') || '(no title)',
      location: propValue(ev, 'LOCATION'),
      description: propValue(ev, 'DESCRIPTION'),
      organizer: (firstProp(ev, 'ORGANIZER')?.params.CN || propValue(ev, 'ORGANIZER').replace(/^mailto:/i, '')),
      status,
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      allDay,
      recurring,
      url: propValue(ev, 'URL'),
    })
  }

  for (const ev of vevents) {
    if (firstProp(ev, 'RECURRENCE-ID')) continue
    const dtstartProp = firstProp(ev, 'DTSTART')
    if (!dtstartProp) continue
    const dtstart = parseDate(dtstartProp, feedTz)
    if (!dtstart) continue
    const uid = propValue(ev, 'UID')
    const allDay = dtstart.dateOnly

    const dtendProp = firstProp(ev, 'DTEND')
    const dtend = dtendProp ? parseDate(dtendProp, feedTz) : null
    const durationMs = dtend
      ? Math.max(0, dtend.wallMs - dtstart.wallMs)
      : allDay ? DAY_MS : parseDurationMs(propValue(ev, 'DURATION')) ?? 60 * 60_000

    const rruleProp = firstProp(ev, 'RRULE')
    const rule = rruleProp ? parseRrule(rruleProp.value, dtstart.tz) : null

    if (!rule) {
      const startMs = toInstant(dtstart)
      const endMs = startMs + durationMs
      if (endMs > fromMs && startMs < toMs) emit(ev, startMs, endMs, allDay, false)
      continue
    }

    const excluded = new Set<number>()
    for (const p of ev.props) {
      if (p.name !== 'EXDATE') continue
      for (const one of p.value.split(',')) {
        const parsed = parseDate({ ...p, value: one }, feedTz)
        if (parsed) excluded.add(toInstant(parsed))
      }
    }

    for (const wall of expand(dtstart.wallMs, rule, dtstart.tz, fromMs, toMs, durationMs)) {
      const startMs = dtstart.tz ? wallToUtc(wall, dtstart.tz) : wall
      if (excluded.has(startMs)) continue
      const override = overrides.get(`${uid}@${startMs}`)
      if (override) {
        const oStart = parseDate(firstProp(override, 'DTSTART')!, feedTz)
        if (!oStart) continue
        const oEndProp = firstProp(override, 'DTEND')
        const oEnd = oEndProp ? parseDate(oEndProp, feedTz) : null
        const s = toInstant(oStart)
        const e = oEnd ? toInstant(oEnd) : s + durationMs
        if (e > fromMs && s < toMs) emit(override, s, e, oStart.dateOnly, true)
        continue
      }
      emit(ev, startMs, startMs + durationMs, allDay, true)
    }
  }

  out.sort((a, b) => a.start.localeCompare(b.start))
  return out
}

/** ISO 8601 duration, the subset a DTEND-less VEVENT actually uses. */
function parseDurationMs(value: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim())
  if (!m) return null
  const [, sign, w, d, h, mi, s] = m
  const ms = (Number(w || 0) * 7 * 86400 + Number(d || 0) * 86400 + Number(h || 0) * 3600 + Number(mi || 0) * 60 + Number(s || 0)) * 1000
  return sign === '-' ? -ms : ms
}
