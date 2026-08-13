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
// How far after its `verdict:` line a run's own output can still land. Most of it
// is milliseconds away, but a run that actually trades spends a broker round trip
// (review + place, per order) between the verdict and the `cost:` line, so this
// has to cover seconds rather than milliseconds. Anything further out belongs to
// a different run and must not be folded into this decision (a later
// verdict-less run would otherwise overwrite its cost).
const RUN_WINDOW_MS = 120_000
// `screen shortlist:` is logged BEFORE the judge call, so its distance from the
// verdict is the judge's own latency — an agentic turn with web search has been
// measured at over two minutes, which RUN_WINDOW_MS would not reach. Scans are
// scheduled hourly and every screening run logs its own shortlist (which
// replaces the pending one), so reaching this far back cannot pick up a
// neighbouring run's names.
const SHORTLIST_REACH_MS = 20 * 60_000

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

/**
 * One name the market screen put in front of the judge on a given run, as the
 * bot logged it. These are the candidates the verdict was actually formed over,
 * so they are the only honest answer to "what was it looking at" — the pinned
 * watchlist is not. `rvol` is null when the screen logged `rvol=?` (no daily
 * volume average for the name), which is not the same as a relative volume of 0.
 */
type ShortlistPick = {
  symbol: string
  change_pct: number | null
  rvol: number | null
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
  // Empty when the run logged no shortlist: the screen was off, it returned
  // nothing, or the run predates the screener. Never padded out with the
  // watchlist, which would misreport what the judge was shown.
  shortlist: ShortlistPick[]
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
  screener: Screener | null
  tiers: ConvictionTier[]
}

/**
 * Conviction tiers, added to config_v2.json on 2026-08-13. Confidence now buys
 * SIZE rather than bare permission, which means min_confidence_to_trade above is
 * no longer "the gate": it is only the bar for FULL size. The real gate is the
 * LOWEST tier's min_confidence, below which nothing trades at any size. Drawing
 * min_confidence_to_trade alone now overstates the bar by a wide margin, so
 * anything on the page that talks about "the gate" has to read the floor from
 * here. An empty array means the config predates tiers, in which case
 * min_confidence_to_trade really is the single threshold.
 */
type ConvictionTier = {
  tier: string
  min_confidence: number
  max_single_trade_pct: number | null
}

/**
 * The screener half of the universe. `watchlist` above is now only the pinned
 * names that are shown every cycle; the bot may also buy anything this screen
 * shortlisted on the run in question, so drawing the watchlist alone
 * understates what it is allowed to touch.
 */
type Screener = {
  enabled: boolean
  shortlist_size: number | null
  min_abs_change_pct: number | null
  min_market_cap: number | null
  min_relative_volume: number | null
}

type PagePayload = {
  generated_at: string
  status: StatusDoc
  stale: boolean
  broker: BrokerSnapshot | null
  broker_error: string | null
  decisions: Decision[]
  decisions_unverified: number
  decisions_truncated: number
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
  screener: null,
  tiers: [],
}

/**
 * conviction_tiers, sorted highest threshold first so `tiers[tiers.length - 1]`
 * is always the floor. A malformed entry is dropped rather than guessed at: a
 * tier with an unreadable threshold or size would otherwise render as a bar the
 * bot does not actually have.
 */
function readTiers(value: unknown): ConvictionTier[] {
  if (!Array.isArray(value)) return []
  const out: ConvictionTier[] = []
  for (const entry of value) {
    if (!isObj(entry)) continue
    const threshold = fnum(entry.min_confidence)
    const name = typeof entry.tier === 'string' ? entry.tier.trim() : ''
    if (threshold == null || !name) continue
    out.push({
      tier: name,
      min_confidence: threshold,
      max_single_trade_pct: fnum(entry.max_single_trade_pct),
    })
  }
  return out.sort((a, b) => b.min_confidence - a.min_confidence)
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
    tiers: readTiers(doc.conviction_tiers),
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
    screener: readScreener(doc.screener),
  }
}

/**
 * A missing or malformed screener block reads as absent rather than as a screen
 * with default thresholds: the page must not claim a market-wide universe the
 * bot is not actually configured for.
 */
function readScreener(raw: unknown): Screener | null {
  if (!isObj(raw) || raw.enabled !== true) return null
  return {
    enabled: true,
    shortlist_size: fnum(raw.shortlist_size),
    min_abs_change_pct: fnum(raw.min_abs_change_pct),
    min_market_cap: fnum(raw.min_market_cap),
    min_relative_volume: fnum(raw.min_relative_volume),
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
// The trailing path is the ledger the cost row went to, and the bot always says
// which one: a --selftest run names its temp file here, so this line is a direct
// statement of whether the run's judge call is in the real ledger at all.
const COST_RE = /^cost:\s+\$([\d.]+)\s+this run(?:\s+->\s+(\S+))?/
const SHORTLIST_RE = /^screen shortlist:\s+(.+)$/
// One pick out of that line: "NBIS +29.2% rvol=2.26". The symbol is required, the
// relative volume is not — scan_v2 logs `rvol=?` when it has no volume average.
const PICK_RE = /^([A-Z][A-Z0-9.\-]*)\s+([+-][\d.]+)%\s+rvol=(\S+)$/
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
  // When this run's `cost:` line named the real ledger, its timestamp; null when
  // it named a temp one or the line never arrived. This is what a recorded judge
  // call is matched against — see readDecisions() for why it is not decision.ts.
  costMs: number | null
}

/**
 * "NBIS +29.2% rvol=2.26, WRD -9.4% rvol=5.17" -> the picks it names.
 * A fragment that does not parse is dropped rather than guessed at: a shortlist
 * that comes up short is honest, one with an invented row in it is not.
 */
function parsePicks(list: string): ShortlistPick[] {
  const picks: ShortlistPick[] = []
  for (const part of list.split(',')) {
    const m = PICK_RE.exec(part.trim())
    if (!m) continue
    picks.push({ symbol: m[1], change_pct: fnum(m[2]), rvol: fnum(m[3]) })
  }
  return picks
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
 * scan_v2.log -> parsed runs, newest first.
 *
 * The log is plain text written by an append-only process, so this parser
 * assumes nothing: a `verdict:` line opens a run, and only lines that both
 * follow it and fall inside its run window can contribute to it. Unknown lines,
 * torn lines and interleaved output from other invocations are ignored, and the
 * whole function is non-throwing — a malformed line must never 500 the page.
 *
 * The one line read the other way round is `screen shortlist:`, which a run emits
 * before it has a verdict to attach it to. It is held pending and claimed by the
 * next verdict.
 */
function parseScanLog(text: string): ScanRun[] {
  const runs: ScanRun[] = []
  let cur: ScanRun | null = null
  let curMs = 0
  // The most recent screen, waiting for the verdict it fed.
  let pending: { ms: number; picks: ShortlistPick[] } | null = null

  for (const rawLine of text.split('\n')) {
    const m = LINE_RE.exec(rawLine)
    if (!m) continue
    const ts = m[1]
    const body = m[2]
    const ms = Date.parse(ts)
    if (!Number.isFinite(ms)) continue

    const verdict = VERDICT_RE.exec(body)
    if (verdict) {
      // Claim the pending screen only when it is near enough to be this run's
      // own. A verdict with no screen behind it shows nothing rather than
      // inheriting the previous run's names.
      const screened =
        pending && ms >= pending.ms && ms - pending.ms <= SHORTLIST_REACH_MS ? pending.picks : []
      pending = null
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
          shortlist: screened,
        },
        gateNote: null,
        notes: [],
        placed: false,
        reviewed: null,
        noTrades: false,
        costMs: null,
      }
      curMs = ms
      runs.push(cur)
      continue
    }

    // The screen runs before the judge, so this line belongs to the NEXT verdict,
    // not to whatever run is still open — which is why it is matched ahead of the
    // no-open-run guard below.
    const screen = SHORTLIST_RE.exec(body)
    if (screen) {
      pending = { ms, picks: parsePicks(screen[1]) }
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
      // Only a row in the real ledger proves a paid judge call. A selftest names
      // its temp file on this line, so a path that is not COST_LOG leaves costMs
      // null and the run stays unverified. An older line with no path at all is
      // read as the real ledger, which is the only one that existed then.
      if (cur.costMs == null && (cost[2] ?? COST_LOG) === COST_LOG) cur.costMs = ms
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
  return runs.reverse()
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
async function readDecisions(): Promise<{
  decisions: Decision[]
  unverified: number
  truncated: number
}> {
  const scanText = await readTail(SCAN_LOG, TAIL_BYTES)
  let live: ScanRun[] = []
  try {
    live = scanText ? parseScanLog(scanText) : []
  } catch {
    live = []
  }

  const judged = await readJudgedSeconds()
  /** Was a judge call recorded at this instant? To the second, ±1s of slack. */
  const recorded = (ms: number | null): boolean => {
    if (ms == null || !Number.isFinite(ms)) return false
    const sec = Math.floor(ms / 1000)
    return judged.has(sec) || judged.has(sec - 1) || judged.has(sec + 1)
  }

  // Keep only verdicts backed by a recorded judge call. --selftest exercises the
  // same logging path, so without this the feed shows fixture runs as [LIVE]
  // decisions.
  //
  // The join key is the run's `cost:` line, NOT its verdict. scan_v2 logs the
  // verdict, then checks open orders, then reviews and places every trade, and
  // only then calls record_cost and logs `cost:`. So on a run that actually
  // trades the cost row lands a broker round trip after the verdict (1-3s, and
  // further with several orders), while it stays microseconds behind the `cost:`
  // line that record_cost is immediately followed by. Matching the verdict second
  // held only while the bot had never traded: the first real execution would have
  // been withheld as a selftest fixture, which is the one event this feed exists
  // to show.
  //
  // The verdict second stays as a fallback so a run whose `cost:` line fell
  // outside the tail (or was torn by rotation) is not dropped either. Fixtures
  // fail both tests: their cost rows go to a temp ledger and never reach
  // cost_v2.jsonl, and the `cost:` line says so.
  const verified = live.filter((r) => recorded(r.costMs) || recorded(Date.parse(r.decision.ts)))

  const ordered = verified
    .map((r) => r.decision)
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
  return {
    decisions: ordered.slice(0, MAX_DECISIONS),
    unverified: live.length - verified.length,
    truncated: Math.max(0, ordered.length - MAX_DECISIONS),
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
    // Verified scans the MAX_DECISIONS slice cut off the end. Reported for the
    // same reason: the bot runs seven scans a weekday, so the feed starts
    // clipping inside a day, and a panel that counts "all N scans" has to be able
    // to say that N is not the whole history.
    decisions_truncated: decisionResult.truncated,
    config,
  }
  pageCache = { at: Date.now(), data }
  res.json(data)
})

export default router
