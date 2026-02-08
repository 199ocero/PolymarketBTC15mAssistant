import { CONFIG } from "../config.js";

/**
 * Evaluate the market context and candles to determine the best scalp strategy.
 * 
 * @param {Object} context
 * @param {string} context.trend "RISING" | "FALLING" | "FLAT"
 * @param {number} context.timeLeftMin
 * @param {number} context.spotPrice
 * @param {number} context.strikePrice
 * @param {Object} context.marketOdds { up, down }
 * @param {Object} context.indicators
 * @param {number} context.indicators.ema21
 * @param {number} context.indicators.ema9
 * @param {number} context.indicators.rsi
 * @param {Object} context.indicators.macd { hist: number, histDelta: number, histPrev: number, histPrev2: number }
 * @param {Object} context.indicators.heikinAshi { color: "green"|"red", count: number }
 * @param {number} context.indicators.vwap
 * @param {Array} context.indicators.candles // 1m candles for history checks
 * 
 * @returns {Object} { action: "ENTER" | "NO_TRADE", strategy: string, side: "UP"|"DOWN", confidence: string, reason: string }
 */
export function evaluateScalpDetails({
  trend,
  timeLeftMin,
  spotPrice,
  strikePrice,
  marketOdds, 
  indicators
}) {
  const result = { action: "NO_TRADE", strategy: null, side: null, confidence: "NONE", reason: "no_setup" };

  if (!indicators || !indicators.ema21 || !indicators.macd || !marketOdds) {
    return { ...result, reason: "missing_data" };
  }

  const { ema21, ema9, rsi, macd, heikinAshi, vwap, candles } = indicators;
  const { up: oddsUp, down: oddsDown } = marketOdds;

  // 1. DECISION TREE BY TIME
  
  // Backtest Advice: "Restriction Late Window to Final 60-90 Seconds"
  // So anything above 1.5 min is "Mid Game" where we only look for Momentum.
  
  // 0. TREND SNIPER (0.5 - 2.0 Mins) - "Guaranteed" Win via Momentum
  if (timeLeftMin >= 0.5 && timeLeftMin <= 2.0) {
     const sniper = checkTrendSniper({ spotPrice, strikePrice, timeLeftMin, heikinAshi, rsi, oddsUp, oddsDown });
     if (sniper.action === "ENTER") return sniper;
  }

  // > 1.5 Mins: Only Momentum (Mean Reversion Disabled)
  if (timeLeftMin > 1.5) {
    return checkMomentum({ spotPrice, strikePrice, timeLeftMin, ema21, heikinAshi, rsi, macd, oddsUp, oddsDown, candles });
  }

  // 1.0 - 1.5 Mins: Late Window Certainty
  if (timeLeftMin >= 1.0 && timeLeftMin <= 1.5) {
    return checkLateWindow({ spotPrice, strikePrice, timeLeftMin, heikinAshi, oddsUp, oddsDown, candles });
  }

  // < 1 Min: No Entry
  return { ...result, reason: "less_than_1m_left" };
}


// --- STRATEGY 1: MOMENTUM BREAKOUT ---
function checkMomentum({ spotPrice, strikePrice, timeLeftMin, ema21, heikinAshi, rsi, macd, oddsUp, oddsDown, candles }) {
  const S = CONFIG.strategy.momentum;
  
  if (spotPrice === null || strikePrice === null) return { action: "NO_TRADE", strategy: "MOMENTUM", side: null, reason: "no_price_data" };

  // Update: Avoid entering if < 1.5 mins left (Relaxed from 3)
  if (timeLeftMin < 1.5) {
      return { action: "NO_TRADE", strategy: "MOMENTUM", side: null, reason: "time_too_short_for_mom" };
  }

  // New Rule: BTC must cross strike by $150+
  // New Rule: Persistence (2 minutes above/below)
  // New Rule: MACD growing for 3+ candles
  
  const diff = spotPrice - strikePrice;
  const THRESHOLD = 50; // Hyper-Scalp: $50 (ATM)

  // Helper for Persistence Check (last 2 closed candles + current? just last 2 minutes so last 2 candles)
  // We need to check if LOW of last 2 candles > Strike (for UP) or HIGH of last 2 candles < Strike (for DOWN)
  // candles array: old -> new. 
  // We need at least 2 closed candles.
  if (!candles || candles.length < 2) return { action: "NO_TRADE", strategy: "MOMENTUM", side: null, reason: "insufficient_history" };
  
  const last2 = candles.slice(-2);
  
  // MACD Growth Check (2 candles: Current, Prev) - Faster entry
  // Growing means Histogram is increasing (more positive or more negative)
  // UP: Hist > PrevHist > 0
  // DOWN: Hist < PrevHist < 0
  
  const macdGrowingUp = 
      macd.hist > 0 && 
      macd.histPrev !== null && macd.histPrev > 0 &&
      macd.hist > macd.histPrev;

  const macdGrowingDown = 
      macd.hist < 0 && 
      macd.histPrev !== null && macd.histPrev < 0 &&
      macd.hist < macd.histPrev;


  // UP SETUP
  const persistenceUp = last2.every(c => c.close > strikePrice); // Simple check: closed above strike
  const isUpSetup = 
    diff > THRESHOLD && // Price > Strike + 200
    persistenceUp &&
    spotPrice > ema21 &&
    heikinAshi.color === "green" && heikinAshi.count >= 2 && // Faster: 2+
    rsi >= 40 && rsi <= 80 && // Hyper-Scalp: Catch strong momentum
    macdGrowingUp;

  if (isUpSetup) {
    // Edge: 15% (Odds < 0.85)
    // Cap at 0.85 (Hyper-Scalp)
    if (oddsUp < 0.85 && oddsUp < (1.0 - S.minOddsEdge)) {
       return { 
         action: "ENTER", 
         strategy: "MOMENTUM", 
         side: "UP", 
         confidence: "HIGH", 
         reason: `mom_up_rsi${rsi.toFixed(0)}_ha${heikinAshi.count}_diff$${diff.toFixed(0)}`
       };
    } else {
        return { action: "NO_TRADE", strategy: "MOMENTUM", side: null, reason: `odds_too_high_up_${oddsUp.toFixed(2)}` };
    }
  }

  // DOWN SETUP
  const persistenceDown = last2.every(c => c.close < strikePrice);
  const isDownSetup = 
    diff < -THRESHOLD && // Price < Strike - 200
    persistenceDown &&
    spotPrice < ema21 &&
    heikinAshi.color === "red" && heikinAshi.count >= 2 && // Faster: 2+
    rsi >= 20 && rsi <= 60 && // Hyper-Scalp: Catch strong momentum
    macdGrowingDown;

  if (isDownSetup) {
    if (oddsDown < 0.85 && oddsDown < (1.0 - S.minOddsEdge)) {
        return { 
          action: "ENTER", 
          strategy: "MOMENTUM", 
          side: "DOWN", 
          confidence: "HIGH", 
          reason: `mom_down_rsi${rsi.toFixed(0)}_ha${heikinAshi.count}_diff$${diff.toFixed(0)}`
        };
    } else {
        return { action: "NO_TRADE", strategy: "MOMENTUM", side: null, reason: `odds_too_high_down_${oddsDown.toFixed(2)}` };
    }
  }

  return { 
      action: "NO_TRADE", 
      strategy: "MOMENTUM", 
      side: null, 
      confidence: "NONE", 
      reason: `no_mom_setup_diff${diff.toFixed(0)}_rsi${rsi.toFixed(0)}_ha${heikinAshi.count}_${heikinAshi.color}` 
  };
}


// --- STRATEGY 2: MEAN REVERSION (DISABLED) ---
// function checkMeanReversion(...) { ... }


// --- STRATEGY 3: LATE WINDOW CERTAINTY ---
function checkLateWindow({ spotPrice, strikePrice, timeLeftMin, heikinAshi, oddsUp, oddsDown, candles }) {
  const S = CONFIG.strategy.lateWindow;
  
  if (spotPrice === null || strikePrice === null) return { action: "NO_TRADE", strategy: "LATE_WINDOW", side: null, reason: "no_price_data" };

  // New Rule: BTC must be $300+ away
  // New Rule: Volatility Check (last 5 mins avg volatility < $80)
  // New Rule: HA >= 5
  
  const diff = spotPrice - strikePrice;
  const THRESHOLD = 300;
  
  // Volatility Check
  if (!candles || candles.length < 5) return { action: "NO_TRADE", strategy: "LATE_WINDOW", side: null, reason: "insufficient_history_vol" };
  const last5 = candles.slice(-5);
  const avgVol = last5.reduce((sum, c) => sum + (c.high - c.low), 0) / last5.length;
  
  if (avgVol > 80) { // If moving more than $80/min on average
      return { action: "NO_TRADE", strategy: "LATE_WINDOW", side: null, reason: `high_volatility_$${avgVol.toFixed(0)}` };
  }

  const isStable = heikinAshi.count >= 5;

  // UP
  if (diff > THRESHOLD) {
      if (isStable && heikinAshi.color === "green") {
          if (oddsUp < S.minOdds) {
             return { 
                 action: "ENTER", 
                 strategy: "LATE_WINDOW", 
                 side: "UP", 
                 confidence: "VERY_HIGH", 
                 reason: `late_up_diff$${diff.toFixed(0)}_vol$${avgVol.toFixed(0)}` 
             };
          }
      }
  }

  // DOWN
  if (diff < -THRESHOLD) {
      if (isStable && heikinAshi.color === "red") {
          if (oddsDown < S.minOdds) {
             return { 
                 action: "ENTER", 
                 strategy: "LATE_WINDOW", 
                 side: "DOWN", 
                 confidence: "VERY_HIGH", 
                 reason: `late_down_diff$${diff.toFixed(0)}_vol$${avgVol.toFixed(0)}` 
             };
          }
      }
  }

  return { action: "NO_TRADE", strategy: "LATE_WINDOW", side: null, reason: "no_late_setup" };
}

// --- STRATEGY 4: TREND SNIPER (0.5 - 2.0m) ---
function checkTrendSniper({ spotPrice, strikePrice, timeLeftMin, heikinAshi, rsi, oddsUp, oddsDown }) {
    if (spotPrice === null || strikePrice === null) return { action: "NO_TRADE", strategy: "SNIPER", side: null, reason: "no_price" };

    const diff = spotPrice - strikePrice;
    const SAFETY_BUFFER = 80; 

    // 1. Must be a "Freight Train" trend
    if (heikinAshi.count < 6) {
        return { action: "NO_TRADE", strategy: "SNIPER", side: null, reason: `ha_count_low_${heikinAshi.count}` };
    }

    // UP SNIPER
    if (diff > SAFETY_BUFFER) {
        if (heikinAshi.color === "green" && rsi > 60) {
            if (oddsUp < 0.90) {
                return {
                    action: "ENTER",
                    strategy: "SNIPER",
                    side: "UP",
                    confidence: "MAX",
                    reason: `sniper_up_ha${heikinAshi.count}_rsi${rsi.toFixed(0)}`
                };
            } else {
                 return { action: "NO_TRADE", strategy: "SNIPER", side: null, reason: `odds_too_high_up_${oddsUp.toFixed(2)}` };
            }
        }
    }

    // DOWN SNIPER
    if (diff < -SAFETY_BUFFER) {
        if (heikinAshi.color === "red" && rsi < 40) {
            if (oddsDown < 0.90) {
                return {
                    action: "ENTER",
                    strategy: "SNIPER",
                    side: "DOWN",
                    confidence: "MAX",
                    reason: `sniper_down_ha${heikinAshi.count}_rsi${rsi.toFixed(0)}`
                };
            } else {
                 return { action: "NO_TRADE", strategy: "SNIPER", side: null, reason: `odds_too_high_down_${oddsDown.toFixed(2)}` };
            }
        }
    }

    return { action: "NO_TRADE", strategy: "SNIPER", side: null, reason: "no_sniper_setup" };
}
