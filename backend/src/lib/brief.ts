import { openDb } from './db.js'
import { askClaude, nyNowLine, nyWallToMs } from './claudeCli.js'
import { listInbox, privateSources } from './inboxStore.js'
import { mailboxes, unreadMail } from './mailStore.js'
import { listProjects } from './projectsStore.js'
import { listTasks, nyToday } from './tasksStore.js'

// The morning brief: one headless Claude run a day (7:30 AM New York time, or
// on demand from the Today page) that reads today's calendar, the due and
// overdue tasks, the unread inbox and the projects' next actions, and writes
// a few short lines at the top of Today. It is written once and kept, so
// opening Today never costs a run. No heartbeat: the OpenClaw one burned 97.6%
// of its account on ticks that said nothing.

const BRIEF_AT = process.env.BRIEF_AT || '07:30'
const TICK_MS = 60_000
const API = `http://127.0.0.1:${process.env.PORT || 3001}/api`

const db = openDb('capture', '')
db.exec(`
  CREATE TABLE IF NOT EXISTS briefs (
    day       TEXT PRIMARY KEY,
    status    TEXT NOT NULL CHECK (status IN ('writing','done','failed')),
    text      TEXT NOT NULL DEFAULT '',
    error     TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
`)

type Row = { day: string; status: 'writing' | 'done' | 'failed'; text: string; error: string | null; createdAt: string; updatedAt: string }
export type Brief = Row

const nowIso = () => new Date().toISOString()

export function todaysBrief(): Brief | null {
  return (db.prepare('SELECT * FROM briefs WHERE day = ?').get(nyToday()) as Row | undefined) ?? null
}

type CalEvent = { summary: string; start: string; end: string; allDay: boolean; location?: string; sourceLabel?: string }

const NY_TIME = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })
const NY_DAY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' })

/** The day's facts, as the plain lines Claude reads. Every time is New York time. */
async function facts(): Promise<string[]> {
  const today = nyToday()
  const from = nyWallToMs(`${today}T00:00`)
  const to = from + 2 * 86_400_000
  const out: string[] = []

  try {
    const r = await fetch(`${API}/calendar/events?from=${from}&to=${to}`)
    const j = await r.json() as { events?: CalEvent[] }
    const evs = (j.events ?? []).filter((e) => Date.parse(e.end) > Date.now() - 3_600_000)
    out.push('Calendar, today and tomorrow:')
    if (!evs.length) out.push('- nothing')
    for (const e of evs.slice(0, 15)) {
      const s = Date.parse(e.start)
      const when = e.allDay ? `${NY_DAY.format(s)} all day` : `${NY_DAY.format(s)} ${NY_TIME.format(s)} to ${NY_TIME.format(Date.parse(e.end))}`
      out.push(`- ${when}: ${e.summary || 'Busy'}${e.location ? ` (${e.location})` : ''}`)
    }
  } catch {
    out.push('Calendar: not answering.')
  }

  const tasks = listTasks({ view: 'open', hideTailnet: false })
  const soon = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(Date.now() + 2 * 86_400_000)
  const dated = tasks.filter((t) => t.due && t.due.slice(0, 10) <= soon)
  out.push(`Tasks: ${tasks.length} open. Overdue or due by ${soon}:`)
  if (!dated.length) out.push('- none')
  for (const t of dated.slice(0, 12)) {
    out.push(`- ${t.due!.slice(0, 10) < today ? 'OVERDUE ' : ''}${t.due}: ${t.text} (${t.project?.name ?? t.area})`)
  }

  const boxes = mailboxes(false).filter((b) => b.syncedAt)
  if (boxes.length) {
    out.push(`Mail: ${boxes.map((b) => `${b.label} ${b.unread ?? '?'} unread`).join(', ')}. Unread Focused mail from the last day:`)
    const recent = unreadMail(false, 1, 10)
    if (!recent.length) out.push('- none')
    for (const m of recent) out.push(`- ${m.label}: ${m.fromName || m.fromAddress}: ${m.subject || '(no subject)'}${m.important ? ' (high importance)' : ''}`)
  }

  // mail already has its own lines above
  const mailSources = privateSources()
  const unread = listInbox({ view: 'open', limit: 40 }).filter((i) => !i.readAt && !mailSources.has(i.source))
  out.push(`Inbox: ${unread.length} unread.`)
  for (const i of unread.sort((a, b) => (a.level === 'alert' ? -1 : 0) - (b.level === 'alert' ? -1 : 0)).slice(0, 8)) {
    out.push(`- [${i.level}] ${i.source}: ${i.title}`)
  }

  const next = listProjects().filter((p) => p.status === 'active' && p.nextAction).slice(0, 8)
  if (next.length) {
    out.push('Projects with a next action:')
    for (const p of next) out.push(`- ${p.name}: ${p.nextAction}`)
  }
  return out
}

function prompt(lines: string[]): string {
  return [
    `Write Brendon's brief for today. Now: ${nyNowLine()}.`,
    'He has ADHD and skims. The first line is the one thing that matters most today, as a plain sentence.',
    'Then at most 5 short lines: what is scheduled (times like 2:30 PM), what is overdue or due, mail that looks like it needs a reply from him, and inbox items that need him.',
    'If the day is light, say so in one line and stop.',
    'Plain text, one item per line, no headings, no bullets, no markdown, no em dashes, US English, no greeting, no sign-off.',
    'Use only the facts below. Never invent anything. Leave out what does not need him today.',
    '',
    ...lines,
  ].join('\n')
}

/** Clean what Claude wrote into the lines shown on Today. */
function clean(text: string): string {
  return text
    .replace(/\s*\u2014\s*/g, ', ')
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').replace(/\*\*|__/g, '').trim())
    .filter(Boolean)
    .slice(0, 7)
    .join('\n')
}

let running: Promise<Brief | null> | null = null

/** Write today's brief now (or join the run already going). */
export function writeBrief(): Promise<Brief | null> {
  if (running) return running
  const day = nyToday()
  const at = nowIso()
  db.prepare(`INSERT INTO briefs (day, status, text, error, createdAt, updatedAt) VALUES (?, 'writing', '', NULL, ?, ?)
    ON CONFLICT(day) DO UPDATE SET status = 'writing', updatedAt = excluded.updatedAt`).run(day, at, at)
  running = (async () => {
    try {
      const text = clean(await askClaude(prompt(await facts()), { timeoutMs: 150_000 }))
      if (!text) throw new Error('Claude wrote nothing')
      db.prepare("UPDATE briefs SET status = 'done', text = ?, error = NULL, updatedAt = ? WHERE day = ?").run(text, nowIso(), day)
    } catch (err) {
      const msg = (err as Error).message.slice(0, 300)
      console.error('[brief] failed:', msg)
      db.prepare("UPDATE briefs SET status = 'failed', error = ?, updatedAt = ? WHERE day = ?").run(msg, nowIso(), day)
    } finally {
      running = null
    }
    return todaysBrief()
  })()
  return running
}

/** Once a minute: after BRIEF_AT with no brief for today, write it. A failed one is retried once an hour. */
export function startBrief(): void {
  const tick = () => {
    const nowWall = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(Date.now())
    if (nowWall < BRIEF_AT) return
    const b = todaysBrief()
    const age = b ? Date.now() - Date.parse(b.updatedAt) : Infinity
    if (b?.status === 'done') return
    // 'writing' long past any run's time limit means a restart cut it off
    if (b?.status === 'writing' && (running || age < 10 * 60_000)) return
    if (b?.status === 'failed' && age < 3_600_000) return
    void writeBrief()
  }
  setTimeout(tick, 30_000)
  setInterval(tick, TICK_MS).unref()
  console.log(`[brief] daily brief at ${BRIEF_AT} New York time`)
}
