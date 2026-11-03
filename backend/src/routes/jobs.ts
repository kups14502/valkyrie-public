import { Router, type Request, type Response } from 'express'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { nyWallToMs } from '../lib/claudeCli.js'

// Job applications (/m/jobs): what the auto-apply runner on odin has submitted,
// what it held back and why, and what Brendon has heard back. The runner keeps
// its own SQLite file (jobs + one applications row per attempt); this reads the
// latest attempt per job and keeps the outcomes he marks (interview, rejected,
// offer, withdrawn) in an `outcomes` table of that same file.
//
// Where the file lives is private config, never in the repo:
// ~/.config/valkyrie/jobs.json = { "db": "/abs/path/jobs.db", "cap": 40, "runs": "7:00 AM" }.

const router = Router()
const CONFIG = process.env.JOBS_CONFIG || path.join(homedir(), '.config', 'valkyrie', 'jobs.json')

type Config = { db: string; cap: number; runs: string }

function config(): Config | null {
  try {
    const c = JSON.parse(readFileSync(CONFIG, 'utf8')) as Partial<Config>
    if (!c.db || !existsSync(c.db)) return null
    return { db: c.db, cap: Number(c.cap) || 40, runs: String(c.runs || '7:00 AM') }
  } catch {
    return null
  }
}

let open: { file: string; db: Database.Database } | null = null

function db(file: string): Database.Database {
  if (open && open.file === file) return open.db
  open?.db.close()
  const d = new Database(file, { fileMustExist: true, timeout: 5000 })
  d.exec(`CREATE TABLE IF NOT EXISTS outcomes (
    job_id TEXT PRIMARY KEY, outcome TEXT NOT NULL, at TEXT NOT NULL)`)
  open = { file, db: d }
  return d
}

export type JobView = 'applied' | 'held' | 'skipped'
export const OUTCOMES = ['interview', 'rejected', 'offer', 'withdrawn'] as const
type Outcome = (typeof OUTCOMES)[number]

// The runner's statuses, folded into the page's three views
const VIEW_OF: Record<string, JobView> = {
  applied: 'applied',
  'needs-review': 'held',
  skipped: 'skipped',
  closed: 'skipped',
  failed: 'skipped',
  limit: 'skipped',
}

// The runner's resume kinds, as the page names them
const RESUME_LABEL: Record<string, string> = { base: 'Base', sysadmin: 'Systems Admin', aiops: 'AI systems' }

const TXFL = /\btexas\b|, ?tx\b|\btx,|austin|dallas|houston|san antonio|fort worth|plano|irving|frisco|\bflorida\b|, ?fl\b|\bfl,|tampa|orlando|miami|jacksonville|fort lauderdale|boca raton|st\.? petersburg/i
const NCPA = /north carolina|, ?nc\b|\bnc,|charlotte|raleigh|durham|\bcary\b|pennsylvania|, ?pa\b|\bpa,|philadelphia|pittsburgh|king of prussia|malvern/i
const REMOTE = /remote|anywhere|distributed|work from home/i

function region(loc: string): string {
  if (TXFL.test(loc)) return 'TX/FL'
  if (NCPA.test(loc)) return 'NC/PA'
  if (REMOTE.test(loc)) return 'Remote'
  return 'Other'
}

/** The runner writes odin's local wall clock (New York) with no zone. */
function wallMs(s: string | null): number | null {
  if (!s) return null
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?/.exec(s)
  if (!m) return null
  return nyWallToMs(`${m[1]}T${m[2]}`) + Number(m[3] ?? 0) * 1000
}

const NY_WALL = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
})

function nowWall(): string {
  const p = Object.fromEntries(NY_WALL.formatToParts(Date.now()).map((x) => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`
}

/** The longer written answers a form got, for reading before an interview. */
function prose(raw: string | null): { q: string; a: string }[] {
  if (!raw) return []
  try {
    const d = JSON.parse(raw) as { answers?: Record<string, unknown>; asked?: { key: string; question: string }[] }
    const asked = new Map((d.asked ?? []).map((x) => [x.key, x.question]))
    return Object.entries(d.answers ?? {})
      .filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].length >= 80)
      .map(([k, a]) => ({ q: asked.get(k) ?? (/^q\d+$|^w\d+$/.test(k) ? '' : k.replace(/^[^:]+:/, '').trim()), a }))
      .slice(0, 8)
  } catch {
    return []
  }
}

type Row = {
  job_id: string; company: string; title: string; location: string | null; site: string | null; posting: string | null
  status: string; at: string; detail: string | null; form: string | null; resume: string | null; answers: string | null
  outcome: string | null; outcome_at: string | null
}

function rows(d: Database.Database): Row[] {
  return d.prepare(`
    SELECT a.job_id, j.company, j.title, j.location, j.site, j.url AS posting,
           a.status, a.at, a.detail, a.url AS form, a.resume, a.answers,
           o.outcome, o.at AS outcome_at
      FROM applications a
      JOIN (SELECT job_id, MAX(rowid) AS r FROM applications GROUP BY job_id) last ON a.rowid = last.r
      JOIN jobs j ON j.job_id = a.job_id
      LEFT JOIN outcomes o ON o.job_id = a.job_id
     ORDER BY a.at DESC`).all() as Row[]
}

function h(fn: (req: Request, res: Response, c: Config) => unknown) {
  return (req: Request, res: Response) => {
    const c = config()
    if (!c) {
      res.status(503).json({ error: 'job applications are not set up on this host' })
      return
    }
    try {
      fn(req, res, c)
    } catch (e) {
      console.error('[jobs]', (e as Error).message)
      if (!res.headersSent) res.status(500).json({ error: 'internal error' })
    }
  }
}

router.get('/jobs', h((req, res, c) => {
  const view: JobView = req.query.view === 'held' ? 'held' : req.query.view === 'skipped' ? 'skipped' : 'applied'
  const all = rows(db(c.db))
  const today = nowWall().slice(0, 10)
  const counts = { applied: 0, held: 0, skipped: 0, today: 0, replies: 0 }
  for (const r of all) {
    const v = VIEW_OF[r.status] ?? 'skipped'
    counts[v] += 1
    if (r.status === 'applied' && r.at.startsWith(today)) counts.today += 1
    if (r.outcome && r.outcome !== 'withdrawn') counts.replies += 1
  }
  const items = all
    .filter((r) => (VIEW_OF[r.status] ?? 'skipped') === view)
    .map((r) => ({
      jobId: r.job_id,
      company: r.company,
      title: r.title,
      location: r.location ?? '',
      region: region(r.location ?? ''),
      ats: (r.site ?? '').replace(/^ats:/, ''),
      status: r.status,
      at: wallMs(r.at),
      detail: r.detail ?? '',
      form: r.form,
      posting: r.posting,
      resume: RESUME_LABEL[r.resume ?? ''] ?? r.resume,
      outcome: r.outcome as Outcome | null,
      outcomeAt: wallMs(r.outcome_at),
      answers: view === 'applied' ? prose(r.answers) : [],
    }))
  res.json({ view, cap: c.cap, runs: c.runs, counts, items })
}))

const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/

router.post('/jobs/:jobId/outcome', h((req, res, c) => {
  const id = String(req.params.jobId)
  const outcome = (req.body ?? {}).outcome as unknown
  if (!JOB_ID.test(id)) { res.status(404).json({ error: 'no such job' }); return }
  if (outcome !== null && !OUTCOMES.includes(outcome as Outcome)) { res.status(400).json({ error: 'unknown outcome' }); return }
  const d = db(c.db)
  if (!d.prepare('SELECT 1 FROM jobs WHERE job_id = ?').get(id)) { res.status(404).json({ error: 'no such job' }); return }
  if (outcome === null) d.prepare('DELETE FROM outcomes WHERE job_id = ?').run(id)
  else d.prepare('INSERT INTO outcomes (job_id, outcome, at) VALUES (?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET outcome = excluded.outcome, at = excluded.at').run(id, outcome, nowWall())
  res.json({ ok: true })
}))

// A held form he will not finish: the runner's next --retry-review leaves it alone.
router.post('/jobs/:jobId/skip', h((req, res, c) => {
  const id = String(req.params.jobId)
  if (!JOB_ID.test(id)) { res.status(404).json({ error: 'no such job' }); return }
  const d = db(c.db)
  const last = d.prepare('SELECT resume, url FROM applications WHERE job_id = ? ORDER BY rowid DESC LIMIT 1').get(id) as { resume: string | null; url: string | null } | undefined
  if (!last) { res.status(404).json({ error: 'no such job' }); return }
  d.transaction(() => {
    d.prepare("INSERT INTO applications (job_id, at, status, resume, url, detail, answers) VALUES (?, ?, 'skipped', ?, ?, 'skipped from Valkyrie', '{}')").run(id, nowWall(), last.resume, last.url)
    d.prepare("UPDATE jobs SET status = 'skipped' WHERE job_id = ?").run(id)
  })()
  res.json({ ok: true })
}))

export default router
