import { Router } from 'express'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const router = Router()

// Everything here is FILE-ONLY and read-only. The trade bot's own cron jobs are
// the writers: status.py every 5 min, equity_sampler.py every 10 min, scan_v2
// per cycle. This route never touches the broker, holds no credentials, and
// does no work a request should wait on.
const BOT_DIR = '/home/brendon/trade-bot'
const STATUS_FILE = path.join(BOT_DIR, 'logs', 'status.json')
const SNAPSHOT_FILE = path.join(BOT_DIR, 'logs', 'broker_snapshot.json')
const SCAN_LOG = path.join(BOT_DIR, 'logs', 'scan_v2.log')
// The ledger of real judge calls. scan_v2 writes a row here only when it
// actually paid an API bill, and only into the real logs dir - a --selftest
// run uses a temp root, so its fixture output never lands here. That makes
// this the proof that a parsed verdict came from a real scan.
const COST_LOG = path.join(BOT_DIR, 'logs', 'cost_v2.jsonl')
const CONFIG_FILE = path.join(BOT_DIR, 'config_v2.json')

const STALE_AFTER_MS = 10 * 60_000
const PAGE_CACHE_TTL_MS = 10_000
const MAX_DECISIONS = 50
// scan_v2.log is append-only and rotated externally; only the tail can hold
// anything recent enough to show, so a runaway file can never be read whole.
const TAIL_BYTES = 512 * 1024
// Every line a scan run emits lands within milliseconds of its `verdict:` line.
// Anything further out belongs to a different run and must not be folded into
// this decision (a later verdict-less run would otherwise overwrite its cost).
const RUN_WINDOW_MS = 120_000

type StatusDoc = Record<string, unknown>

type Realized = { pnl_usd: number | null; round_trips: number | null }
type SnapPosition = {
  symbol: string
  quantity: number | null
  shares_available_for_sells: number | null
  average_buy_price: number | null
}
type SnapFill = {
  ts: string
  symbol: string
  side: string
  quantity: number | null
  price: number | null
  state: string | null
  placed_agent: string | null
  order_id: string | null
}
type BrokerSnapshot = {
  generated_at: string | null
  positions: SnapPosition[]
  fills: SnapFill[]
  realized: Realized
}

// gate is the answer to "did this decision reach the broker": null when the
// model proposed nothing, "executed" when orders were placed, otherwise the
// reason it was stopped.
type Decision = {
  ts: string
  arm: 'live'
  regime: string | null
  confidence: number | null
  trade_needed: boolean | null
  trades_proposed: number | null
  summary: string | null
  gate: string | null
  cost_usd: number | null
}

type Caps = {
  min_confidence_to_trade: number | null
  max_position_pct: number | null
  max_single_trade_pct: number | null
  max_trades_per_day: number | null
  daily_loss_limit_pct: number | null
  stop_loss_pct: number | null
  gain_trim_pct: number | null
  gain_trim_partial_pct: number | null
  model: string | null
  watchlist: string[]
}

type PagePayload = {
  generated_at: string
  status: StatusDoc
  stale: boolean
  broker: BrokerSnapshot | null
  broker_error: string | null
  decisions: Decision[]
  decisions_unverified: number
  config: Caps
}

// ---------- tolerant primitives ----------

/** Finite number or null. Accepts the numeric strings the broker API returns. */
const fnum = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

const fstr = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' ? v : null

const isObj = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v)

async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
}

/**
 * Last `bytes` of a file, with the first (possibly mid-line) fragment dropped.
 * Tolerates a file shorter than the window and a file that vanishes between the
 * stat and the read (log rotation).
 */
async function readTail(file: string, bytes: number): Promise<string | null> {
  let handle
  try {
    handle = await fs.open(file, 'r')
  } catch {
    return null
  }
  try {
    const { size } = await handle.stat()
    const start = size > bytes ? size - bytes : 0
    const length = size - start
    if (length <= 0) return ''
    const buf = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buf, 0, length, start)
    const text = buf.subarray(0, bytesRead).toString('utf8')
    if (start === 0) return text
    const nl = text.indexOf('\n')
    return nl === -1 ? '' : text.slice(nl + 1)
  } catch {
    return null
  } finally {
    await handle.close().catch(() => {})
  }
}

// ---------- broker snapshot ----------

const mapPosition = (p: Record<string, unknown>): SnapPosition => ({
  symbol: String(p.symbol ?? ''),
  quantity: fnum(p.quantity),
  shares_available_for_sells: fnum(p.shares_available_for_sells),
  average_buy_price: fnum(p.average_buy_price),
})

const mapFill = (f: Record<string, unknown>): SnapFill => ({
  ts: String(f.ts ?? ''),
  symbol: String(f.symbol ?? ''),
  side: String(f.side ?? ''),
  quantity: fnum(f.quantity),
  price: fnum(f.price),
  state: fstr(f.state),
  placed_agent: fstr(f.placed_agent),
  order_id: fstr(f.order_id),
})

/**
 * broker_snapshot.json -> (snapshot, error). Returns an error string rather than
 * a fabricated empty snapshot: "the exporter has not run" and "the account is
 * flat" are different facts and the page says which one it is.
 */
async function readSnapshot(): Promise<[BrokerSnapshot | null, string | null]> {
  const raw = await readText(SNAPSHOT_FILE)
  if (raw == null) {
    return [null, 'broker_snapshot.json missing (equity_sampler has not exported one yet)']
  }
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    return [null, 'broker_snapshot.json unreadable (corrupt or torn write)']
  }
  if (!isObj(doc)) return [null, 'broker_snapshot.json is not an object']
  const realizedRaw = isObj(doc.realized) ? doc.realized : {}
  return [{
    generated_at: fstr(doc.generated_at),
    positions: Array.isArray(doc.positions) ? doc.positions.filter(isObj).map(mapPosition) : [],
    fills: Array.isArray(doc.fills) ? doc.fills.filter(isObj).map(mapFill) : [],
    realized: {
      pnl_usd: fnum(realizedRaw.pnl_usd),
      round_trips: fnum(realizedRaw.round_trips),
    },
  }, null]
}

// ---------- config caps ----------

const EMPTY_CAPS: Caps = {
  min_confidence_to_trade: null,
  max_position_pct: null,
  max_single_trade_pct: null,
  max_trades_per_day: null,
  daily_loss_limit_pct: null,
  stop_loss_pct: null,
  gain_trim_pct: null,
  gain_trim_partial_pct: null,
  model: null,
  watchlist: [],
}

/**
 * Only the caps the UI draws. config_v2.json also carries a Discord channel id,
 * three years of market holidays and a page of prose — none of which belongs on
 * the wire.
 */
async function readCaps(): Promise<Caps> {
  const raw = await readText(CONFIG_FILE)
  if (raw == null) return EMPTY_CAPS
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    return EMPTY_CAPS
  }
  if (!isObj(doc)) return EMPTY_CAPS
  return {
    min_confidence_to_trade: fnum(doc.min_confidence_to_trade),
    max_position_pct: fnum(doc.max_position_pct),
    max_single_trade_pct: fnum(doc.max_single_trade_pct),
    max_trades_per_day: fnum(doc.max_trades_per_day),
    daily_loss_limit_pct: fnum(doc.daily_loss_limit_pct),
    stop_loss_pct: fnum(doc.stop_loss_pct),
    gain_trim_pct: fnum(doc.gain_trim_pct),
    gain_trim_partial_pct: fnum(doc.gain_trim_partial_pct),
    model: fstr(doc.model),
    watchlist: Array.isArray(doc.stock_watchlist)
      ? doc.stock_watchlist.filter((s): s is string => typeof s === 'string')
      : [],
  }
}

// ---------- decision feed ----------

/**
 * A gate note -> the canonical short form. The confidence case is the one that
 * matters today (it is why the bot has never traded), so it gets a fixed shape;
 * anything else is passed through verbatim rather than guessed at.
 */
function gateLabel(note: string): string {
  const trimmed = note.trim()
  const conf = /^confidence\s+([\d.]+)\s+below\s+min_confidence_to_trade\s+([\d.]+)/i.exec(trimmed)
  if (conf) return `blocked: confidence ${conf[1]} < ${conf[2]}`
  return `blocked: ${trimmed}`
}

const LINE_RE = /^\[([^\]]+)\]\s?(.*)$/
const VERDICT_RE = /^verdict:\s+regime=(\S+)\s+trade_needed=(\S+)\s+confidence=([\d.]+)\s+trades=(\d+)/
const COST_RE = /^cost:\s+\$([\d.]+)\s+this run/
const PLACING_RE = /^LIVE:\s+placing\s+(\d+)\s+order/
const DRYRUN_RE = /^DRY RUN:\s+reviewing\s+(\d+)\s+order/
// Post-gate notes. A SIZING CLAMP resizes a trade and a SIZING DROP removes one,
// so a note alone does not mean nothing traded — see resolveGate().
const NOTE_RE = /^(CAP|SIZING|SELLS|SKIP)\s+(.*)$/
const HALT_RE = /^LOSS HALT\s+(.*)$/
const NO_TRADES = 'No trades after Python invariants'

/** Per-run scratch state; only `decision` is served. */
type ScanRun = {
  decision: Decision
  gateNote: string | null
  notes: string[]
  placed: boolean
  reviewed: number | null
  noTrades: boolean
}

/**
 * What actually happened to this decision, in precedence order.
 *
 * The confidence gate is checked first because it is the only stage that stops
 * everything before sizing runs. Placement beats the post-gate notes on purpose:
 * "SIZING CLAMP buy NVDA $5000 -> $N" resized an order that then went in, and
 * reporting that as blocked would be a lie.
 */
function resolveGate(run: ScanRun): string | null {
  if (run.gateNote) return gateLabel(run.gateNote)
  if (run.placed) return 'executed'
  if (run.reviewed != null) {
    return `blocked: dry run, ${run.reviewed} order(s) reviewed but not placed`
  }
  if (!run.noTrades) return null
  if (run.notes.length > 0) return gateLabel(run.notes[0])
  if ((run.decision.trades_proposed ?? 0) > 0) {
    return 'blocked: dropped by the python invariants'
  }
  return null
}

/**
 * scan_v2.log -> live decisions, newest first.
 *
 * The log is plain text written by an append-only process, so this parser
 * assumes nothing: a `verdict:` line opens a run, and only lines that both
 * follow it and fall inside its run window can contribute to it. Unknown lines,
 * torn lines and interleaved output from other invocations are ignored, and the
 * whole function is non-throwing — a malformed line must never 500 the page.
 */
function parseScanLog(text: string): Decision[] {
  const runs: ScanRun[] = []
  let cur: ScanRun | null = null
  let curMs = 0

  for (const rawLine of text.split('\n')) {
    const m = LINE_RE.exec(rawLine)
    if (!m) continue
    const ts = m[1]
    const body = m[2]
    const ms = Date.parse(ts)
    if (!Number.isFinite(ms)) continue

    const verdict = VERDICT_RE.exec(body)
    if (verdict) {
      cur = {
        decision: {
          ts,
          arm: 'live',
          regime: verdict[1],
          // Python's bools land in the log capitalised.
          trade_needed: /^true$/i.test(verdict[2]) ? true
            : /^false$/i.test(verdict[2]) ? false : null,
          confidence: fnum(verdict[3]),
          trades_proposed: fnum(verdict[4]),
          summary: null,
          gate: null,
          cost_usd: null,
        },
        gateNote: null,
        notes: [],
        placed: false,
        reviewed: null,
        noTrades: false,
      }
      curMs = ms
      runs.push(cur)
      continue
    }

    if (!cur) continue
    if (Math.abs(ms - curMs) > RUN_WINDOW_MS) {
      // A different run's output; this one is closed.
      cur = null
      continue
    }

    if (body.startsWith('summary:')) {
      if (cur.decision.summary == null) {
        cur.decision.summary = body.slice('summary:'.length).trim() || null
      }
      continue
    }
    if (body.startsWith('GATE:')) {
      if (cur.gateNote == null) cur.gateNote = body.slice('GATE:'.length).trim()
      continue
    }
    const cost = COST_RE.exec(body)
    if (cost) {
      if (cur.decision.cost_usd == null) cur.decision.cost_usd = fnum(cost[1])
      continue
    }
    if (PLACING_RE.test(body)) {
      cur.placed = true
      continue
    }
    const dry = DRYRUN_RE.exec(body)
    if (dry) {
      if (cur.reviewed == null) cur.reviewed = fnum(dry[1])
      continue
    }
    if (body === NO_TRADES) {
      cur.noTrades = true
      continue
    }
    const note = NOTE_RE.exec(body)
    if (note) {
      cur.notes.push(`${note[1].toLowerCase()} ${note[2]}`)
      continue
    }
    const halt = HALT_RE.exec(body)
    if (halt) cur.notes.push(`daily loss limit: ${halt[1]}`)
  }

  for (const run of runs) run.decision.gate = resolveGate(run)
  return runs.map((r) => r.decision).reverse()
}

// Timestamps (whole seconds) of every judge call the bot recorded paying for.
// Empty set => we cannot verify anything, so the feed shows nothing rather than
// risk presenting fixtures as real decisions.
async function readJudgedSeconds(): Promise<Set<number>> {
  const out = new Set<number>()
  const raw = await readTail(COST_LOG, TAIL_BYTES)
  if (!raw) return out
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      const row = JSON.parse(t) as unknown
      if (!isObj(row)) continue
      const ms = Date.parse(String((row as { ts?: unknown }).ts ?? ''))
      if (Number.isFinite(ms)) out.add(Math.floor(ms / 1000))
    } catch {
      // A torn trailing line is expected when reading a tail; skip it.
    }
  }
  return out
}

// The paper arm was retired 2026-08-04, so scan_v2.log is the only decision
// source left; logs/paper/runs.jsonl and its parser are gone with it.
async function readDecisions(): Promise<{ decisions: Decision[]; unverified: number }> {
  const scanText = await readTail(SCAN_LOG, TAIL_BYTES)
  let live: Decision[] = []
  try {
    live = scanText ? parseScanLog(scanText) : []
  } catch {
    live = []
  }

  // Keep only verdicts backed by a recorded judge call. --selftest exercises the
  // same logging path, so without this the feed shows fixture runs as [LIVE]
  // decisions. Matched to the second, with one second of slack because the cost
  // row is written just after the verdict line.
  const judged = await readJudgedSeconds()
  const verified = live.filter((d) => {
    const ms = Date.parse(d.ts)
    if (!Number.isFinite(ms)) return false
    const sec = Math.floor(ms / 1000)
    return judged.has(sec) || judged.has(sec - 1) || judged.has(sec + 1)
  })

  return {
    decisions: verified.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, MAX_DECISIONS),
    unverified: live.length - verified.length,
  }
}

// ---------- status ----------

type StatusResult =
  | { ok: true; status: StatusDoc; stale: boolean }
  | { ok: false; detail: string }

async function readStatus(): Promise<StatusResult> {
  const raw = await readText(STATUS_FILE)
  if (raw == null) {
    return { ok: false, detail: 'status.json missing (generator has not run yet)' }
  }
  let status: StatusDoc
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!isObj(parsed)) throw new Error('not an object')
    status = parsed
  } catch {
    return { ok: false, detail: 'status.json unreadable (corrupt or torn write)' }
  }
  const generatedAt = Date.parse(String(status.generated_at ?? ''))
  const stale = !Number.isFinite(generatedAt) || Date.now() - generatedAt > STALE_AFTER_MS
  return { ok: true, status, stale }
}

// ---------- routes ----------

router.get('/tradebot/status', async (_req, res) => {
  const result = await readStatus()
  if (!result.ok) return res.status(503).json({ error: 'status unavailable', detail: result.detail })
  res.json({ ...result.status, stale: result.stale })
})

let pageCache: { at: number; data: PagePayload } | null = null

// One payload for the whole trade page: status.json verbatim, the broker
// snapshot, the parsed decision feed and the config caps. Assembled from local
// files so the page is a single request and the backend stays synchronous-fast.
router.get('/tradebot/page', async (_req, res) => {
  if (pageCache && Date.now() - pageCache.at < PAGE_CACHE_TTL_MS) return res.json(pageCache.data)

  const status = await readStatus()
  // Same contract as /tradebot/status: without status.json there is no page.
  if (!status.ok) return res.status(503).json({ error: 'status unavailable', detail: status.detail })

  const [[broker, brokerError], decisionResult, config] = await Promise.all([
    readSnapshot(), readDecisions(), readCaps(),
  ])

  const data: PagePayload = {
    generated_at: new Date().toISOString(),
    status: status.status,
    stale: status.stale,
    broker,
    broker_error: brokerError,
    decisions: decisionResult.decisions,
    // Verdicts parsed out of the log with no recorded judge call behind them
    // (selftest fixtures). Surfaced rather than silently dropped so the feed
    // never looks complete when it is filtered.
    decisions_unverified: decisionResult.unverified,
    config,
  }
  pageCache = { at: Date.now(), data }
  res.json(data)
})

export default router
