import { Router } from 'express'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const router = Router()

const TRADING_DIR = '/home/brendon/trading'
const ANALYSIS_FILE = path.join(TRADING_DIR, 'analysis.json')
const LOGS_DIR = path.join(TRADING_DIR, 'logs')
const TRADE_LOG = path.join(TRADING_DIR, 'trade.log')
const CACHE_TTL_MS = 30_000

type Position = {
  symbol: string
  quantity: number
  avgBuyPrice: number
  currentPrice: number
  pnlPct: number
  locked: boolean
}

type Signal = {
  symbol: string
  direction: string
  conviction: string
  reasoning: string
  suggestedInstrument: string | null
  timeHorizon: string | null
}

type ExecutedTrade = {
  symbol: string
  action: string
  assetType: string
  status: string
  timestamp: string
}

type PlannedTrade = {
  action: string
  assetType: string
  symbol: string
  quantity: number | null
  dollarAmount: number | null
  optionType: string | null
  strikePrice: number | null
  expirationDate: string | null
  notes: string | null
}

type EquityPoint = { date: string; equity: number }

type RealizedPnl = {
  totalUSD: number
  closedTrades: number
  bySymbol: Record<string, { realizedUSD: number; trades: number }>
}

type TradingStatus = {
  lastUpdated: string | null
  marketRegime: string | null
  marketSummary: string | null
  signals: Signal[]
  portfolio: {
    equity: number
    buyingPower: number
    stockPositions: Position[]
    cryptoPositions: Position[]
    optionsPositions: Position[]
  } | null
  latestRun: {
    timestamp: string
    sonnetSummary: string | null
    plan: { reasoning: string; riskAssessment: string; trades: PlannedTrade[] } | null
  } | null
  runsToday: number
  executedToday: ExecutedTrade[]
  executedRecent: ExecutedTrade[]
  equityHistory: EquityPoint[]
  realized: RealizedPnl
}

let cache: { at: number; data: TradingStatus } | null = null

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : (v as number)
  return Number.isFinite(n) ? n : 0
}

const mapPosition = (p: any): Position => ({
  symbol: String(p.symbol ?? ''),
  quantity: num(p.quantity),
  avgBuyPrice: num(p.avg_buy_price),
  currentPrice: num(p.current_price),
  pnlPct: num(p.pnl_pct),
  locked: Boolean(p.locked),
})

const mapSignal = (s: any): Signal => ({
  symbol: String(s.symbol ?? ''),
  direction: String(s.direction ?? ''),
  conviction: String(s.conviction ?? ''),
  reasoning: String(s.reasoning ?? ''),
  suggestedInstrument: s.suggested_instrument ?? null,
  timeHorizon: s.time_horizon ?? null,
})

const mapTrade = (t: any): PlannedTrade => ({
  action: String(t.action ?? ''),
  assetType: String(t.asset_type ?? ''),
  symbol: String(t.symbol ?? ''),
  quantity: t.quantity == null ? null : num(t.quantity),
  dollarAmount: t.dollar_amount == null ? null : num(t.dollar_amount),
  optionType: t.option_type ?? null,
  strikePrice: t.strike_price == null ? null : num(t.strike_price),
  expirationDate: t.expiration_date ?? null,
  notes: t.notes ?? null,
})

async function readAnalysis(): Promise<{ lastUpdated: string | null; regime: string | null; summary: string | null; signals: Signal[] }> {
  try {
    const raw = await fs.readFile(ANALYSIS_FILE, 'utf8')
    const a = JSON.parse(raw) as any
    const latest = a.latest ?? {}
    return {
      lastUpdated: a.last_updated ?? null,
      regime: latest.market_regime ?? null,
      summary: latest.market_summary ?? null,
      signals: Array.isArray(latest.signals) ? latest.signals.map(mapSignal) : [],
    }
  } catch {
    return { lastUpdated: null, regime: null, summary: null, signals: [] }
  }
}

async function readLatestLog(): Promise<{ portfolio: TradingStatus['portfolio']; latestRun: TradingStatus['latestRun']; runsToday: number }> {
  try {
    const files = (await fs.readdir(LOGS_DIR))
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort()
    if (files.length === 0) return { portfolio: null, latestRun: null, runsToday: 0 }
    const latestFile = files[files.length - 1]
    const raw = await fs.readFile(path.join(LOGS_DIR, latestFile), 'utf8')
    const day = JSON.parse(raw) as any
    const runs: any[] = Array.isArray(day.runs) ? day.runs : []
    if (runs.length === 0) return { portfolio: null, latestRun: null, runsToday: 0 }
    const last = runs[runs.length - 1]
    // Manual re-execution entries may have incomplete snapshots; find the last run with equity
    const snapRun = [...runs].reverse().find((r) => r.portfolio_snapshot?.equity != null) ?? last
    const snap = snapRun.portfolio_snapshot ?? {}
    const portfolio = {
      equity: num(snap.equity),
      buyingPower: num(snap.buying_power),
      stockPositions: Array.isArray(snap.stock_positions) ? snap.stock_positions.map(mapPosition) : [],
      cryptoPositions: Array.isArray(snap.crypto_positions) ? snap.crypto_positions.map(mapPosition) : [],
      optionsPositions: Array.isArray(snap.options_positions) ? snap.options_positions.map(mapPosition) : [],
    }
    const plan = last.plan
      ? {
          reasoning: String(last.plan.reasoning ?? ''),
          riskAssessment: String(last.plan.risk_assessment ?? ''),
          trades: Array.isArray(last.plan.trades) ? last.plan.trades.map(mapTrade) : [],
        }
      : null
    const latestRun = {
      timestamp: String(last.timestamp ?? ''),
      sonnetSummary: last.sonnet_summary ?? null,
      plan,
    }
    return { portfolio, latestRun, runsToday: runs.length }
  } catch {
    return { portfolio: null, latestRun: null, runsToday: 0 }
  }
}

type SnapPos = { qty: number; avgBuyPrice: number; currentPrice: number; locked: boolean }
type DateSnap = { date: string; positions: Record<string, SnapPos> }

function collectPositions(snap: any): Record<string, SnapPos> {
  const out: Record<string, SnapPos> = {}
  const buckets = [snap?.stock_positions, snap?.crypto_positions, snap?.options_positions]
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) continue
    for (const p of bucket) {
      const sym = p?.symbol
      if (!sym) continue
      out[String(sym)] = {
        qty: num(p.quantity),
        avgBuyPrice: num(p.avg_buy_price),
        currentPrice: num(p.current_price),
        locked: Boolean(p.locked),
      }
    }
  }
  return out
}

async function readDailySnapshots(): Promise<DateSnap[]> {
  try {
    const files = (await fs.readdir(LOGS_DIR))
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort()
    const out: DateSnap[] = []
    for (const file of files) {
      const date = file.slice(0, 10)
      try {
        const raw = await fs.readFile(path.join(LOGS_DIR, file), 'utf8')
        const day = JSON.parse(raw) as { runs?: Array<{ portfolio_snapshot?: any }> }
        const runs = day.runs ?? []
        if (runs.length === 0) continue
        const snap = runs[runs.length - 1]?.portfolio_snapshot
        if (snap) out.push({ date, positions: collectPositions(snap) })
      } catch { /* skip */ }
    }
    return out
  } catch {
    return []
  }
}

function computeRealized(snaps: DateSnap[]): RealizedPnl {
  const tracked: Record<string, { qty: number; cost: number; lastPrice: number }> = {}
  const bySymbol: Record<string, { realizedUSD: number; trades: number }> = {}
  let total = 0
  let closedTrades = 0

  const addRealized = (symbol: string, pnl: number) => {
    if (!bySymbol[symbol]) bySymbol[symbol] = { realizedUSD: 0, trades: 0 }
    bySymbol[symbol].realizedUSD += pnl
    bySymbol[symbol].trades += 1
    total += pnl
    closedTrades += 1
  }

  for (let i = 0; i < snaps.length; i++) {
    const cur = snaps[i].positions
    const prev = i === 0 ? {} : snaps[i - 1].positions

    // detect symbols that disappeared since last snap (full sell)
    for (const [sym, posPrev] of Object.entries(prev)) {
      if (posPrev.locked) continue
      if (sym in cur) continue
      const t = tracked[sym]
      if (!t || t.qty <= 0) continue
      const proceeds = t.qty * posPrev.currentPrice
      addRealized(sym, proceeds - t.cost)
      t.qty = 0
      t.cost = 0
    }

    // process current snap symbols
    for (const [sym, pos] of Object.entries(cur)) {
      if (pos.locked) continue
      const t = tracked[sym] ?? { qty: 0, cost: 0, lastPrice: 0 }
      if (pos.qty > t.qty + 1e-9) {
        // bought (initial or added); rebase cost basis to snapshot's running total
        t.cost = pos.qty * pos.avgBuyPrice
        t.qty = pos.qty
      } else if (pos.qty < t.qty - 1e-9) {
        // partial sell using PREVIOUS snapshot's price as sell price (within ~30s of execution)
        const prevPos = prev[sym]
        const sellPrice = prevPos ? prevPos.currentPrice : pos.currentPrice
        const sellQty = t.qty - pos.qty
        const costOfSold = t.qty > 0 ? (t.cost * sellQty) / t.qty : 0
        const proceeds = sellQty * sellPrice
        addRealized(sym, proceeds - costOfSold)
        t.cost -= costOfSold
        t.qty = pos.qty
      }
      t.lastPrice = pos.currentPrice
      tracked[sym] = t
    }
  }

  return { totalUSD: total, closedTrades, bySymbol }
}

async function readEquityHistory(): Promise<EquityPoint[]> {
  try {
    const files = (await fs.readdir(LOGS_DIR))
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort()
    const points: EquityPoint[] = []
    for (const file of files) {
      const date = file.slice(0, 10)
      try {
        const raw = await fs.readFile(path.join(LOGS_DIR, file), 'utf8')
        const day = JSON.parse(raw) as { runs?: Array<{ portfolio_snapshot?: { equity?: number | string } }> }
        const runs = day.runs ?? []
        if (runs.length === 0) continue
        const eq = num(runs[runs.length - 1]?.portfolio_snapshot?.equity)
        if (Number.isFinite(eq) && eq > 0) points.push({ date, equity: eq })
      } catch { /* skip malformed day */ }
    }
    return points
  } catch {
    return []
  }
}

async function readExecutedTrades(): Promise<ExecutedTrade[]> {
  try {
    const log = await fs.readFile(TRADE_LOG, 'utf8')
    const lines = log.split('\n')
    const results: ExecutedTrade[] = []
    let currentTs: string | null = null
    let expecting = 0
    for (const line of lines) {
      const tsMatch = line.match(/^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d+)\]/)
      if (tsMatch) currentTs = `${tsMatch[1]}T${tsMatch[2]}`
      if (/Executing \d+ trade/.test(line)) {
        const m = line.match(/Executing (\d+) trade/)
        expecting = m ? Number(m[1]) : 0
        continue
      }
      if (expecting > 0) {
        const tradeMatch = line.match(/^\s+\[([\w.]+)\]\s+(\w+)\s+(\w+)(?:\s+[—-]\s+(.+))?$/)
        if (tradeMatch) {
          const [, symbol, action, assetType, status] = tradeMatch
          if (currentTs) {
            results.push({
              symbol,
              action: action.toLowerCase(),
              assetType: assetType.toLowerCase(),
              status: (status ?? 'submitted').trim(),
              timestamp: currentTs,
            })
          }
          expecting--
        }
      }
    }
    return results
  } catch {
    return []
  }
}

router.get('/trading', async (_req, res) => {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return res.json(cache.data)
  const [analysis, log, executed, equityHistory, snaps] = await Promise.all([
    readAnalysis(), readLatestLog(), readExecutedTrades(), readEquityHistory(), readDailySnapshots(),
  ])
  const todayPrefix = new Date().toISOString().slice(0, 10)
  const executedToday = executed.filter((e) => e.timestamp.startsWith(todayPrefix))
  const executedRecent = executed.slice().reverse().slice(0, 20)
  const realized = computeRealized(snaps)
  const data: TradingStatus = {
    lastUpdated: analysis.lastUpdated,
    marketRegime: analysis.regime,
    marketSummary: analysis.summary,
    signals: analysis.signals,
    portfolio: log.portfolio,
    latestRun: log.latestRun,
    runsToday: log.runsToday,
    executedToday,
    executedRecent,
    equityHistory,
    realized,
  }
  cache = { at: Date.now(), data }
  res.json(data)
})

export default router
