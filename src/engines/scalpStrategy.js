import { CONFIG } from "../config.js";

/**
 * Evaluate the market context and candles to determine the best scalp strategy.
 * 
 * @param {Object} context
 * @param {string} context.trend "RISING" | "FALLING" | "FLAT" (from higher timeframe or algos, effectively EMA21 direction)
 * @param {number} context.timeLeftMin
 * @param {number} context.spotPrice
 * @param {number} context.strikePrice
 * @param {Object} context.marketOdds { bestAsk: number, bestBid: number } or estimated from mid
 * @param {Object} context.indicators
 * @param {number} context.indicators.ema21
 * @param {number} context.indicators.ema9
 * @param {number} context.indicators.rsi
 * @param {Object} context.indicators.macd { hist: number, histDelta: number }
 * @param {Object} context.indicators.heikinAshi { color: "green"|"red", count: number }
 * @param {number} context.indicators.vwap
 * 
 * @returns {Object} { action: "ENTER" | "NO_TRADE", strategy: string, side: "UP"|"DOWN", confidence: string, reason: string }
 */
export function evaluateScalpDetails({
  trend,
  timeLeftMin,
  spotPrice,
  strikePrice,
  marketOdds, // { up: 0.55, down: 0.45 } (market prices)
  indicators
}) {
  const result = { action: "NO_TRADE", strategy: null, side: null, confidence: "NONE", reason: "no_setup" };

  if (!indicators || !indicators.ema21 || !indicators.macd || !marketOdds) {
    return { ...result, reason: "missing_data" };
  }

  const { ema21, ema9, rsi, macd, heikinAshi, vwap } = indicators;
  const { up: oddsUp, down: oddsDown } = marketOdds;

  // 1. DECISION TREE BY TIME
  
  // > 12 Mins: Only Momentum
  if (timeLeftMin > 12) {
    return checkMomentum({ spotPrice, strikePrice, timeLeftMin, ema21, heikinAshi, rsi, macd, oddsUp, oddsDown });
  }

  // 7-12 Mins: VWAP Mean Reversion OR Momentum
  if (timeLeftMin >= 7 && timeLeftMin <= 12) {
    // Prefer Mean Reversion if setup exists
    const meanRev = checkMeanReversion({ spotPrice, strikePrice, timeLeftMin, ema9, vwap, rsi, oddsUp, oddsDown });
    if (meanRev.action === "ENTER") return meanRev;
    
    // Fallback to Momentum
    return checkMomentum({ spotPrice, strikePrice, timeLeftMin, ema21, heikinAshi, rsi, macd, oddsUp, oddsDown });
  }

  // 3-7 Mins: Momentum Continuation Only (Stricter?)
  if (timeLeftMin > 3 && timeLeftMin < 7) {
    // Only strong momentum
    return checkMomentum({ spotPrice, strikePrice, timeLeftMin, ema21, heikinAshi, rsi, macd, oddsUp, oddsDown });
  }

  // 1-3 Mins: Late Window Certainty
  if (timeLeftMin >= 1 && timeLeftMin <= 3) {
    return checkLateWindow({ spotPrice, strikePrice, timeLeftMin, heikinAshi, oddsUp, oddsDown });
  }

  // < 1 Min: No Entry
  return { ...result, reason: "less_than_1m_left" };
}


// --- STRATEGY 1: MOMENTUM BREAKOUT ---
function checkMomentum({ spotPrice, strikePrice, timeLeftMin, ema21, heikinAshi, rsi, macd, oddsUp, oddsDown }) {
  const S = CONFIG.strategy.momentum;
  
  // Direction Determination
  // Requirements:
  // 1. Price vs Strike (Price > Strike for UP)
  // 2. EMA 21 Trend (Price > EMA21 for UP)
  // 3. Heikin Ashi (2+ Green for UP)
  // 4. RSI (50-70 for UP)
  // 5. MACD (Positive & Growing for UP)
  
  // UP SETUP
  const isUpSetup = 
    spotPrice > strikePrice &&
    spotPrice > ema21 &&
    heikinAshi.color === "green" && heikinAshi.count >= 2 &&
    rsi >= S.rsiMin && rsi <= S.rsiMax &&
    macd.hist > 0 && macd.histDelta > 0;

  if (isUpSetup) {
    // Check Value/Edge: "Odds at least 10% below where they should be"
    // Heuristic: If momentum is this strong, odds should be > 0.60 or 0.70.
    // If odds are e.g. 0.55, buy.
    // Let's implement the generic "Min Edge 10%" check logic strictly if we had a model.
    // Without a ML model here, we assume "Fair Value" is higher.
    // Let's just require odds < 0.80 so we have room?
    // User Example: "YES 55 cents (should be 70)".
    if (oddsUp < 0.85) {
       return { 
         action: "ENTER", 
         strategy: "MOMENTUM", 
         side: "UP", 
         confidence: "HIGH", 
         reason: `mom_up_rsi${rsi.toFixed(0)}_ha${heikinAshi.count}`
       };
    }
  }

  // DOWN SETUP
  const isDownSetup = 
    spotPrice < strikePrice &&
    spotPrice < ema21 &&
    heikinAshi.color === "red" && heikinAshi.count >= 2 &&
    rsi >= S.rsiMinDown && rsi <= S.rsiMaxDown &&
    macd.hist < 0 && macd.histDelta < 0; // Negative and growing (more negative)

  if (isDownSetup) {
    if (oddsDown < 0.85) {
        return { 
          action: "ENTER", 
          strategy: "MOMENTUM", 
          side: "DOWN", 
          confidence: "HIGH", 
          reason: `mom_down_rsi${rsi.toFixed(0)}_ha${heikinAshi.count}`
        };
    }
  }

  return { action: "NO_TRADE", strategy: "MOMENTUM", side: null, confidence: "NONE", reason: "no_momentum_setup" };
}


// --- STRATEGY 2: VWAP MEAN REVERSION ---
function checkMeanReversion({ spotPrice, strikePrice, timeLeftMin, ema9, vwap, rsi, oddsUp, oddsDown }) {
  const S = CONFIG.strategy.meanReversion;
  
  const distPct = (spotPrice - vwap) / vwap; // Positive = Above VWAP
  const distAbs = Math.abs(distPct);
  
  // Must be away from VWAP
  if (distAbs < S.vwapDeviation) return { action: "NO_TRADE", strategy: "MEAN_REV", side: null, reason: "too_close_vwap" };

  // UP Reversion (Price is BELOW VWAP, we bet UP to return to VWAP)
  if (spotPrice < vwap) { 
     // Conditions:
     // 1. RSI Oversold (< 35)
     // 2. EMA 9 curling up? (Price > EMA9 implies start of reversal, or slope of EMA9 > 0)
     //    Simplification: Price crossed above EMA9 recently? Or just Price > EMA9 check?
     //    "EMA 9 starting to curl back toward VWAP" -> tough to measure curl without history.
     //    Proxy: Current Price > EMA9 (shows short term strength)
     // 3. Price "wrong side" of strike? (Strike > Price) usually true if we are buying YES.
     
     if (rsi < S.rsiOversold && spotPrice > ema9) {
         return {
             action: "ENTER",
             strategy: "MEAN_REVERSION",
             side: "UP", // Betting on rise to VWAP
             confidence: "MEDIUM",
             reason: `vwap_rev_up_rsi${rsi.toFixed(0)}_dist${(distAbs*100).toFixed(2)}%`
         };
     }
  }

  // DOWN Reversion (Price is ABOVE VWAP, we bet DOWN)
  if (spotPrice > vwap) {
      if (rsi > S.rsiOverbought && spotPrice < ema9) {
          return {
              action: "ENTER",
              strategy: "MEAN_REVERSION",
              side: "DOWN",
              confidence: "MEDIUM",
              reason: `vwap_rev_down_rsi${rsi.toFixed(0)}_dist${(distAbs*100).toFixed(2)}%`
          };
      }
  }

  return { action: "NO_TRADE", strategy: "MEAN_REV", side: null, reason: "no_reversion_setup" };
}


// --- STRATEGY 3: LATE WINDOW CERTAINTY ---
function checkLateWindow({ spotPrice, strikePrice, timeLeftMin, heikinAshi, oddsUp, oddsDown }) {
  const S = CONFIG.strategy.lateWindow;
  
  // "BTC is clearly above/below strike"
  // "No signs of sharp reversal"
  // Odds are "mispriced" (< 0.90 but almost certain)

  const isStable = heikinAshi.count >= 3; // Same color for 3+ candles (stable trend)

  // UP
  if (spotPrice > strikePrice) {
      // Check if price is safe margin? 
      // Maybe 0.05%?
      const margin = (spotPrice - strikePrice) / strikePrice;
      if (margin > 0.0005 && isStable && heikinAshi.color === "green") {
          if (oddsUp < S.minOdds) {
             return { action: "ENTER", strategy: "LATE_WINDOW", side: "UP", confidence: "VERY_HIGH", reason: "late_certainty_up" };
          }
      }
  }

  // DOWN
  if (spotPrice < strikePrice) {
      const margin = (strikePrice - spotPrice) / strikePrice;
      if (margin > 0.0005 && isStable && heikinAshi.color === "red") {
          if (oddsDown < S.minOdds) {
             return { action: "ENTER", strategy: "LATE_WINDOW", side: "DOWN", confidence: "VERY_HIGH", reason: "late_certainty_down" };
          }
      }
  }

  return { action: "NO_TRADE", strategy: "LATE_WINDOW", side: null, reason: "no_late_setup" };
}
