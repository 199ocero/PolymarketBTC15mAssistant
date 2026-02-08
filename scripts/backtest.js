import sqlite3 from "sqlite3";
import path from "node:path";
import fs from "node:fs";
import { computeEma } from "../src/indicators/ema.js";
import { computeRsi, sma, slopeLast } from "../src/indicators/rsi.js";
import { computeMacd } from "../src/indicators/macd.js";
import { computeHeikenAshi, countConsecutive } from "../src/indicators/heikenAshi.js";
import { computeSessionVwap, computeVwapSeries } from "../src/indicators/vwap.js";
import { evaluateScalpDetails } from "../src/engines/scalpStrategy.js";
import { CONFIG } from "../src/config.js";

const DB_PATH = path.resolve("./logs/trading_data.db");

if (!fs.existsSync(DB_PATH)) {
  console.error("No database found at", DB_PATH);
  process.exit(1);
}

const db = new sqlite3.Database(DB_PATH);

async function fetchAllSignals() {
  return new Promise((resolve, reject) => {
    db.all("SELECT * FROM signals ORDER BY timestamp ASC", (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Mock Paper Trader for Backtest
const paperState = {
  balance: 100,
  positions: [],
  dailyLoss: 0,
  trades: []
};

// Main Backtest Loop
async function runBacktest() {
  console.log("Loading history...");
  const rows = await fetchAllSignals();
  console.log(`Loaded ${rows.length} rows.`);

  if (rows.length === 0) return;

  // 1. Candlestick Aggregation (1-minute candles)
  const candles = [];
  let currentCandle = null;

  const getMinute = (ts) => Math.floor(new Date(ts).getTime() / 60000);

  let lastMinute = -1;
  
  console.log("Starting Simulation...");

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const ts = new Date(row.timestamp).getTime();
    const min = Math.floor(ts / 60000);
    const price = row.binance_price || row.current_price;

    if (!price) continue;

    // Candle Building
    if (min !== lastMinute) {
      if (currentCandle) {
        candles.push(currentCandle);
      }
      currentCandle = {
        open: price,
        high: price,
        low: price,
        close: price,
        volume: 100, 
        time: min * 60000
      };
      lastMinute = min;
    } else {
      if (currentCandle) {
        currentCandle.high = Math.max(currentCandle.high, price);
        currentCandle.low = Math.min(currentCandle.low, price);
        currentCandle.close = price;
      }
    }

    // Need enough candles for indicators (e.g. 26+ for MACD, 21 for EMA)
    if (candles.length < 30) continue; 

    const relevantCandles = candles; // Use all or slice if memory issue
    const closes = relevantCandles.map(c => c.close);
    
    // Indicators
    const ema21 = computeEma(closes, 21);
    const ema9 = computeEma(closes, 9);
    const ema200 = computeEma(closes, 200); // For trend
    const rsi = computeRsi(closes, 14);
    
    // MACD
    const macd = computeMacd(closes, 12, 26, 9);
    
    // Heikin Ashi
    const ha = computeHeikenAshi(relevantCandles);
    const consec = countConsecutive(ha);
    
    // VWAP
    const vwap = computeSessionVwap(relevantCandles.slice(-60)); // 1 hour VWAP proxy

    const trend = (ema21 && price > ema21) ? "RISING" : "FALLING";

    // Prepare Context
    const context = {
        trend,
        timeLeftMin: row.time_left_min,
        spotPrice: price,
        strikePrice: row.price_to_beat,
        marketOdds: { up: row.mkt_up, down: row.mkt_down },
        indicators: {
            ema21,
            ema9,
            rsi,
            macd,
            heikinAshi: consec,
            vwap,
            candles: relevantCandles // Pass history
        }
    };

    // DECIDE
    const rec = evaluateScalpDetails(context);

    // SIMULATE PAPER TRADER with Rec
    updatePaperTrader(rec, row, price);
  }

  console.log("--- Backtest Complete ---");
  console.log("Final Balance:", paperState.balance.toFixed(2));
  console.log("Total Trades:", paperState.trades.length);
  const wins = paperState.trades.filter(t => t.pnl > 0).length;
  console.log(`Win Rate: ${wins}/${paperState.trades.length} (${paperState.trades.length > 0 ? (wins/paperState.trades.length*100).toFixed(1) : 0}%)`);
  
  if (paperState.trades.length > 0) {
      console.table(paperState.trades);
  } else {
      console.log("No trades executed.");
  }
}

function calculateFee(amount, price) {
    if (CONFIG.paper.usePolymarketDynamicFees) {
        // Polymarket Formula: fee = amount * 0.25 * (price * (1 - price))^2
        return amount * 0.25 * Math.pow(price * (1 - price), 2);
    }
    return amount * (CONFIG.paper.feePct / 100);
}

function updatePaperTrader(rec, row, price) {
    const { positions } = paperState;
    const timeLeftMin = row.time_left_min;

    // 1. Check Exits
    for (let i = positions.length - 1; i >= 0; i--) {
        const pos = positions[i];
        const marketOdds = pos.side === "UP" ? row.mkt_up : row.mkt_down;
        
        if (!marketOdds) continue;

        const roiPct = ((marketOdds - pos.entryPrice) / pos.entryPrice) * 100;
        
        let shouldExit = false;
        let reason = "";

        // Time Guard
        const isLateWindow = pos.strategy === "LATE_WINDOW";
        const timeGuard = isLateWindow ? 0.5 : (CONFIG.paper.timeGuardMinutes || 2); 
        
        if (timeLeftMin <= timeGuard) {
             shouldExit = true;
             reason = `TIME_GUARD_EXIT (<${timeGuard}m)`;
        }

        // SL
        if (!shouldExit && roiPct <= -CONFIG.paper.stopLossRoiPct) {
            shouldExit = true;
            reason = `STOP_LOSS (${roiPct.toFixed(1)}%)`;
        }

        // TP
        if (!shouldExit) {
            if (pos.strategy === "MOMENTUM") {
                if (roiPct >= (CONFIG.paper.momentumTakeProfitRoiPct || 50)) {
                    shouldExit = true;
                    reason = `TP_MOMENTUM (+${roiPct.toFixed(1)}%)`;
                }
            } else if (pos.strategy === "MEAN_REVERSION") {
                if (marketOdds >= 0.50) {
                    shouldExit = true;
                    reason = `TP_MEAN_REV (Price > 50¢)`;
                }
            } else if (roiPct >= CONFIG.paper.takeProfitRoiPct) {
                shouldExit = true;
                reason = `TAKE_PROFIT_LEGACY`;
            }
        }
        
        // Expiry?
        if (timeLeftMin <= 0) {
             shouldExit = true;
             reason = "EXPIRY";
             const win = pos.side === "UP" ? (price >= row.price_to_beat) : (price < row.price_to_beat);
             const finalOdds = win ? 1.0 : 0.0;
             const proceeds = finalOdds * pos.shares;
             const pnl = proceeds - pos.amount;
             
             paperState.balance += proceeds;
             paperState.trades.push({
                type: "EXIT",
                strategy: pos.strategy,
                side: pos.side,
                entry: pos.entryPrice.toFixed(2),
                exit: finalOdds.toFixed(2),
                pnl: pnl,
                reason
            });
            positions.splice(i, 1);
            continue;
        }

        if (shouldExit) {
            let proceeds = marketOdds * pos.shares;
            const fee = calculateFee(proceeds, marketOdds);
            proceeds -= fee;
            const pnl = proceeds - pos.amount;

            paperState.balance += proceeds;
            paperState.trades.push({
                type: "EXIT",
                strategy: pos.strategy,
                side: pos.side,
                entry: pos.entryPrice.toFixed(2),
                exit: marketOdds.toFixed(2),
                pnl: pnl,
                reason
            });
            positions.splice(i, 1);
        }
    }

    // 2. Check Entries
    if (rec.action === "ENTER") {
        const maxPos = CONFIG.paper.maxConcurrentPositions || 2;
        if (positions.length < maxPos) {
             const odds = rec.side === "UP" ? row.mkt_up : row.mkt_down;
             if (odds === null || odds === undefined || odds <= 0 || odds >= 1) return;

             let tradeAmount = CONFIG.paper.maxBet; 
             if (rec.strategy === "LATE_WINDOW") tradeAmount = 5;
             else if (rec.strategy === "MOMENTUM") tradeAmount = 4;
             else if (rec.strategy === "MEAN_REVERSION") tradeAmount = 3;
             else tradeAmount = CONFIG.paper.minBet;

             const fee = calculateFee(tradeAmount, odds);
             const totalCost = tradeAmount + fee;

             if (paperState.balance >= totalCost) {
                 paperState.balance -= totalCost;
                 positions.push({
                     side: rec.side,
                     strategy: rec.strategy,
                     entryPrice: odds,
                     amount: totalCost,
                     shares: tradeAmount / odds
                 });
             }
        }
    }
}

runBacktest();
