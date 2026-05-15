import { Router } from 'express'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const router = Router()

const TRADING_DIR = '/home/brendon/trading'
const ANALYSIS_FILE = path.join(TRADING_DIR, 'analysis.json')
const LOGS_DIR = path.join(TRADING_DIR, 'logs')
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
    const snap = last.portfolio_snapshot ?? {}
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

router.get('/trading', async (_req, res) => {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return res.json(cache.data)
  const [analysis, log] = await Promise.all([readAnalysis(), readLatestLog()])
  const data: TradingStatus = {
    lastUpdated: analysis.lastUpdated,
    marketRegime: analysis.regime,
    marketSummary: analysis.summary,
    signals: analysis.signals,
    portfolio: log.portfolio,
    latestRun: log.latestRun,
    runsToday: log.runsToday,
  }
  cache = { at: Date.now(), data }
  res.json(data)
})

export default router
