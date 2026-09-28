import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { openDb } from '../lib/db.js'
import { CLAUDE_ACCOUNTS } from '../lib/claudeAccounts.js'

const execFileAsync = promisify(execFile)

const router = Router()

// Macro log. The client owns the calendar date (it sends 'YYYY-MM-DD' from the
// device's own clock) so a server in UTC can't push a 9pm dinner into
// tomorrow's totals.

const db = openDb('meals', `
  CREATE TABLE IF NOT EXISTS meal_targets (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    calories REAL, protein REAL, carbs REAL, fat REAL, fiber REAL,
    updatedAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS meals (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    time TEXT NOT NULL DEFAULT '',
    slot TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    servings REAL NOT NULL DEFAULT 1,
    calories REAL NOT NULL DEFAULT 0,
    protein REAL NOT NULL DEFAULT 0,
    carbs REAL NOT NULL DEFAULT 0,
    fat REAL NOT NULL DEFAULT 0,
    fiber REAL NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'manual',
    photoId TEXT NOT NULL DEFAULT '',
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS meals_date ON meals (date);
  CREATE TABLE IF NOT EXISTS meal_photos (
    id TEXT PRIMARY KEY,
    mime TEXT NOT NULL,
    bytes BLOB NOT NULL,
    createdAt TEXT NOT NULL
  );
`)

export type Meal = {
  id: string; date: string; time: string; slot: string; name: string; servings: number
  calories: number; protein: number; carbs: number; fat: number; fiber: number
  note: string; source: string; photoId: string; createdAt: string; updatedAt: string
}

type Targets = { calories: number | null; protein: number | null; carbs: number | null; fat: number | null; fiber: number | null; updatedAt: string | null }

const NO_TARGETS: Targets = { calories: null, protein: null, carbs: null, fat: null, fiber: null, updatedAt: null }

const MACROS = ['calories', 'protein', 'carbs', 'fat', 'fiber'] as const
const SLOTS = new Set(['breakfast', 'lunch', 'dinner', 'snack', ''])
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const num = (v: unknown, fallback = 0): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(0, Math.round(n * 100) / 100) : fallback
}

/** A macro target is optional: absent stays absent instead of becoming zero. */
const optionalNum = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null
}

function readTargets(): Targets {
  const row = db.prepare('SELECT * FROM meal_targets WHERE id = 1').get() as (Targets & { id: number }) | undefined
  if (!row) return NO_TARGETS
  return { calories: row.calories, protein: row.protein, carbs: row.carbs, fat: row.fat, fiber: row.fiber, updatedAt: row.updatedAt }
}

const emptyTotals = () => ({ calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 })

function totalsFor(meals: Meal[]) {
  const totals = emptyTotals()
  for (const m of meals) {
    for (const key of MACROS) totals[key] += m[key] * (m.servings || 1)
  }
  for (const key of MACROS) totals[key] = Math.round(totals[key] * 10) / 10
  return totals
}

router.get('/meals/day', (req, res) => {
  const date = String(req.query.date || '')
  if (!DATE_RE.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' })
  const meals = db.prepare('SELECT * FROM meals WHERE date = ? ORDER BY time, createdAt').all(date) as Meal[]
  res.json({ date, meals, totals: totalsFor(meals), targets: readTargets() })
})

router.get('/meals/range', (req, res) => {
  const from = String(req.query.from || '')
  const to = String(req.query.to || '')
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' })
  const meals = db.prepare('SELECT * FROM meals WHERE date BETWEEN ? AND ? ORDER BY date, time').all(from, to) as Meal[]
  const byDate = new Map<string, Meal[]>()
  for (const m of meals) {
    const list = byDate.get(m.date) ?? []
    list.push(m)
    byDate.set(m.date, list)
  }
  const days = [...byDate.entries()]
    .map(([date, list]) => ({ date, entries: list.length, totals: totalsFor(list) }))
    .sort((a, b) => a.date.localeCompare(b.date))
  res.json({ from, to, days, targets: readTargets() })
})

function mealFromBody(body: any, existing?: Meal): Omit<Meal, 'id' | 'createdAt'> | { error: string } {
  const date = String(body?.date ?? existing?.date ?? '')
  if (!DATE_RE.test(date)) return { error: 'date must be YYYY-MM-DD' }
  const name = String(body?.name ?? existing?.name ?? '').trim().slice(0, 200)
  if (!name) return { error: 'name is required' }
  const slot = String(body?.slot ?? existing?.slot ?? '').toLowerCase()
  if (!SLOTS.has(slot)) return { error: 'slot must be breakfast, lunch, dinner or snack' }
  const servings = Math.max(0.01, num(body?.servings ?? existing?.servings ?? 1, 1))
  return {
    date,
    time: String(body?.time ?? existing?.time ?? '').slice(0, 5),
    slot,
    name,
    servings,
    calories: num(body?.calories ?? existing?.calories),
    protein: num(body?.protein ?? existing?.protein),
    carbs: num(body?.carbs ?? existing?.carbs),
    fat: num(body?.fat ?? existing?.fat),
    fiber: num(body?.fiber ?? existing?.fiber),
    note: String(body?.note ?? existing?.note ?? '').slice(0, 2000),
    source: String(body?.source ?? existing?.source ?? 'manual').slice(0, 20),
    photoId: String(body?.photoId ?? existing?.photoId ?? '').slice(0, 64),
    updatedAt: new Date().toISOString(),
  }
}

router.post('/meals', (req, res) => {
  const parsed = mealFromBody(req.body)
  if ('error' in parsed) return res.status(400).json(parsed)
  const id = randomUUID()
  const row = { ...parsed, id, createdAt: new Date().toISOString() }
  db.prepare(`INSERT INTO meals (id,date,time,slot,name,servings,calories,protein,carbs,fat,fiber,note,source,photoId,createdAt,updatedAt)
    VALUES (@id,@date,@time,@slot,@name,@servings,@calories,@protein,@carbs,@fat,@fiber,@note,@source,@photoId,@createdAt,@updatedAt)`).run(row)
  res.json({ ok: true, meal: row })
})

router.patch('/meals/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM meals WHERE id = ?').get(req.params.id) as Meal | undefined
  if (!existing) return res.status(404).json({ error: 'no such meal' })
  const parsed = mealFromBody(req.body, existing)
  if ('error' in parsed) return res.status(400).json(parsed)
  db.prepare(`UPDATE meals SET date=@date,time=@time,slot=@slot,name=@name,servings=@servings,
    calories=@calories,protein=@protein,carbs=@carbs,fat=@fat,fiber=@fiber,note=@note,source=@source,
    photoId=@photoId,updatedAt=@updatedAt WHERE id=@id`).run({ ...parsed, id: existing.id })
  res.json({ ok: true, meal: { ...existing, ...parsed } })
})

router.delete('/meals/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM meals WHERE id = ?').get(req.params.id) as Meal | undefined
  const info = db.prepare('DELETE FROM meals WHERE id = ?').run(req.params.id)
  // A photo belongs to its entry; nothing else references it.
  if (existing?.photoId) {
    const stillUsed = db.prepare('SELECT COUNT(*) AS n FROM meals WHERE photoId = ?').get(existing.photoId) as { n: number }
    if (stillUsed.n === 0) db.prepare('DELETE FROM meal_photos WHERE id = ?').run(existing.photoId)
  }
  res.json({ ok: true, deleted: info.changes })
})

router.get('/meals/targets', (_req, res) => res.json({ targets: readTargets() }))

router.put('/meals/targets', (req, res) => {
  const row = {
    calories: optionalNum(req.body?.calories),
    protein: optionalNum(req.body?.protein),
    carbs: optionalNum(req.body?.carbs),
    fat: optionalNum(req.body?.fat),
    fiber: optionalNum(req.body?.fiber),
    updatedAt: new Date().toISOString(),
  }
  db.prepare(`INSERT INTO meal_targets (id, calories, protein, carbs, fat, fiber, updatedAt)
    VALUES (1, @calories, @protein, @carbs, @fat, @fiber, @updatedAt)
    ON CONFLICT(id) DO UPDATE SET calories=@calories, protein=@protein, carbs=@carbs, fat=@fat, fiber=@fiber, updatedAt=@updatedAt`)
    .run(row)
  res.json({ ok: true, targets: readTargets() })
})

router.get('/meals/photo/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM meal_photos WHERE id = ?').get(req.params.id) as { mime: string; bytes: Buffer } | undefined
  if (!row) return res.status(404).json({ error: 'no such photo' })
  res.setHeader('Content-Type', row.mime)
  res.setHeader('Cache-Control', 'private, max-age=86400')
  res.send(row.bytes)
})

// ---------------------------------------------------------------------------
// Photo estimation
// ---------------------------------------------------------------------------

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const ESTIMATE_MODEL = process.env.MEALS_MODEL || 'claude-sonnet-5'
const ESTIMATE_TIMEOUT_MS = Number(process.env.MEALS_TIMEOUT_MS) || 180_000

const ESTIMATE_TOOL = {
  name: 'log_food',
  description: 'Report the food visible in the photo, one entry per distinct item, with per-serving macros.',
  input_schema: {
    type: 'object' as const,
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Short food name, e.g. "grilled chicken thigh".' },
            portion: { type: 'string', description: 'The portion this entry describes, e.g. "6 oz" or "1 cup".' },
            servings: { type: 'number', description: 'How many of that portion are in the photo.' },
            calories: { type: 'number', description: 'Calories per single serving.' },
            protein: { type: 'number', description: 'Grams of protein per serving.' },
            carbs: { type: 'number', description: 'Grams of carbohydrate per serving.' },
            fat: { type: 'number', description: 'Grams of fat per serving.' },
            fiber: { type: 'number', description: 'Grams of fiber per serving.' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
          required: ['name', 'servings', 'calories', 'protein', 'carbs', 'fat'],
        },
      },
      notes: { type: 'string', description: 'What is uncertain, and what would pin it down (a label, a weight).' },
    },
    required: ['items'],
  },
}

const ESTIMATE_SYSTEM = [
  'You estimate the macronutrients of food in photographs for a personal food log.',
  'Break the plate into its distinct foods and give per-serving numbers, not plate totals.',
  'Use common reference portions and visible cues for scale (plate, utensils, hands, packaging).',
  'Read any nutrition label or menu text in the photo and prefer it over estimation.',
  'Estimate a number for every macro. Never refuse and never return an empty item list for food that is visible.',
  'Say what is uncertain in notes. Mark an item low confidence when the preparation or oil content is hidden.',
].join(' ')

type Estimated = {
  items: Array<Record<string, unknown>>
  notes: string
}

function coerceEstimate(raw: unknown): Estimated | null {
  const obj = raw as { items?: unknown; notes?: unknown } | null
  if (!obj || !Array.isArray(obj.items) || obj.items.length === 0) return null
  return { items: obj.items as Array<Record<string, unknown>>, notes: String(obj.notes ?? '') }
}

// ---- Path 1: the Messages API with an API key -----------------------------
// A straight vision call with a forced tool, so the shape is guaranteed and it
// answers in a couple of seconds. Used whenever ANTHROPIC_API_KEY is set.

async function estimateViaApiKey(apiKey: string, mime: string, base64: string, hint: string): Promise<Estimated> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ESTIMATE_TIMEOUT_MS)
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: ESTIMATE_MODEL,
        max_tokens: 2000,
        system: ESTIMATE_SYSTEM,
        tools: [ESTIMATE_TOOL],
        tool_choice: { type: 'tool', name: 'log_food' },
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } },
            { type: 'text', text: hint ? `Estimate the macros. Context from me: ${hint}` : 'Estimate the macros of this food.' },
          ],
        }],
      }),
    })
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '')
      console.error('[meals] api-key estimate failed', { status: resp.status, detail: detail.slice(0, 400) })
      if (resp.status === 401 || resp.status === 403) throw new Error('Claude rejected ANTHROPIC_API_KEY')
      if (resp.status === 429) throw new Error('Claude rate limit hit. Try again in a few minutes.')
      throw new Error(`Claude returned ${resp.status}`)
    }
    const data = await resp.json() as { content?: Array<{ type: string; name?: string; input?: unknown }> }
    const call = data.content?.find((b) => b.type === 'tool_use' && b.name === 'log_food')
    const parsed = coerceEstimate(call?.input)
    if (!parsed) throw new Error('Claude returned no food items for that photo')
    return parsed
  } finally {
    clearTimeout(timer)
  }
}

// ---- Path 2: the Claude Code CLI under a signed-in profile ----------------
// The fallback when there is no API key, and the default on odin, which
// already holds several signed-in Claude Code profiles: this rides one of them
// instead of adding a billed credential. An OAuth token posted straight at
// /v1/messages is refused (verified 2026-09-09: rate_limit_error immediately,
// on two different accounts), so the CLI is the only way that credential can
// actually be spent.
//
// The photo is written to a directory of its own and the CLI is started there
// with Read as its only tool, so nothing but that one file is reachable.

const CLI_CANDIDATES = [
  process.env.CLAUDE_CLI_PATH,
  '/home/brendon/.local/bin/claude',
  '/usr/local/bin/claude',
].filter((p): p is string => Boolean(p))

const CLI_PROMPT = [
  ESTIMATE_SYSTEM,
  'Read the image file in this directory, then reply with ONE compact JSON object and nothing else:',
  '{"items":[{"name":"","portion":"","servings":1,"calories":0,"protein":0,"carbs":0,"fat":0,"fiber":0,"confidence":"high|medium|low"}],"notes":""}',
  'Macro numbers are per single serving. No prose, no code fence, no explanation outside the JSON.',
].join(' ')

/** Pull the JSON object out of a CLI answer that may be fenced or padded. */
function extractJson(text: string): unknown | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const body = fenced ? fenced[1] : text
  const first = body.indexOf('{')
  const last = body.lastIndexOf('}')
  if (first < 0 || last <= first) return null
  try {
    return JSON.parse(body.slice(first, last + 1))
  } catch {
    return null
  }
}

async function estimateViaCli(mime: string, base64: string, hint: string): Promise<Estimated> {
  const cli = CLI_CANDIDATES.find((candidate) => existsSync(candidate))
  if (!cli) throw new Error('no Claude credential: set ANTHROPIC_API_KEY, or install the claude CLI on this host')
  const accountId = process.env.MEALS_CLAUDE_ACCOUNT
  const account = CLAUDE_ACCOUNTS.find((a) => a.id === accountId) ?? CLAUDE_ACCOUNTS[0]
  if (!account) throw new Error('no Claude profile configured')

  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : mime === 'image/gif' ? 'gif' : 'jpg'
  const dir = await mkdtemp(path.join(tmpdir(), 'valkyrie-meal-'))
  const file = path.join(dir, `plate.${ext}`)
  try {
    await writeFile(file, Buffer.from(base64, 'base64'))
    const prompt = `${CLI_PROMPT} The file is ${path.basename(file)}.${hint ? ` Context from me: ${hint}` : ''}`
    const { stdout } = await execFileAsync(cli, [
      '-p', prompt,
      '--model', ESTIMATE_MODEL,
      '--allowed-tools', 'Read',
      '--permission-mode', 'bypassPermissions',
      '--output-format', 'json',
    ], {
      cwd: dir,
      timeout: ESTIMATE_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: account.configDir,
        // A key in the environment shadows the profile's OAuth sign-in, which
        // is the credential this path exists to spend.
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_AUTH_TOKEN: '',
      },
    })
    // --output-format json wraps the answer; a bare answer is handled too.
    let answer = stdout
    const envelope = extractJson(stdout) as { result?: string } | null
    if (envelope && typeof envelope.result === 'string') answer = envelope.result
    const parsed = coerceEstimate(extractJson(answer))
    if (!parsed) {
      console.error('[meals] cli estimate unparseable', answer.slice(0, 400))
      throw new Error('Claude did not return usable numbers for that photo')
    }
    return parsed
  } catch (err) {
    const e = err as Error & { killed?: boolean; code?: string }
    if (e.killed || e.code === 'ETIMEDOUT') throw new Error('Claude took too long to answer')
    throw err
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

router.post('/meals/estimate', async (req, res) => {
  const mime = String(req.body?.mime || '').toLowerCase()
  const base64 = String(req.body?.imageBase64 || '').replace(/^data:[^,]+,/, '')
  const hint = String(req.body?.hint || '').slice(0, 500)
  if (!ALLOWED_MIME.has(mime)) return res.status(400).json({ error: 'mime must be image/jpeg, png, webp or gif' })
  if (!base64) return res.status(400).json({ error: 'imageBase64 is required' })
  // base64 carries 3 bytes per 4 characters.
  if (base64.length * 0.75 > MAX_IMAGE_BYTES) return res.status(413).json({ error: 'image is over 5 MB after encoding' })

  const apiKey = process.env.ANTHROPIC_API_KEY
  const via = apiKey ? 'api-key' : 'cli'
  try {
    const estimate = apiKey
      ? await estimateViaApiKey(apiKey, mime, base64, hint)
      : await estimateViaCli(mime, base64, hint)

    const items = estimate.items.slice(0, 20).map((it) => ({
      name: String(it?.name || 'food').slice(0, 200),
      portion: String(it?.portion || '').slice(0, 80),
      servings: Math.max(0.01, num(it?.servings, 1)),
      calories: num(it?.calories),
      protein: num(it?.protein),
      carbs: num(it?.carbs),
      fat: num(it?.fat),
      fiber: num(it?.fiber),
      confidence: ['high', 'medium', 'low'].includes(String(it?.confidence)) ? String(it?.confidence) : 'medium',
    }))

    // Keep the photo so the saved entry can show what was estimated, even if
    // every number is corrected afterward.
    const photoId = randomUUID()
    db.prepare('INSERT INTO meal_photos (id, mime, bytes, createdAt) VALUES (?, ?, ?, ?)')
      .run(photoId, mime, Buffer.from(base64, 'base64'), new Date().toISOString())

    res.json({ ok: true, photoId, items, notes: estimate.notes, model: ESTIMATE_MODEL, via })
  } catch (err) {
    const message = (err as Error).message || 'estimation failed'
    console.error('[meals] estimate error', { via, message })
    res.status(502).json({ error: message })
  }
})

// A photo that was estimated but never saved onto an entry is dead weight.
// Swept hourly rather than on write so a slow user is never raced.
const PHOTO_TTL_MS = 6 * 60 * 60_000
setInterval(() => {
  try {
    const cutoff = new Date(Date.now() - PHOTO_TTL_MS).toISOString()
    db.prepare(`DELETE FROM meal_photos WHERE createdAt < ?
      AND id NOT IN (SELECT photoId FROM meals WHERE photoId <> '')`).run(cutoff)
  } catch (err) {
    console.error('[meals] photo sweep failed', (err as Error).message)
  }
}, 60 * 60_000).unref()

export default router
