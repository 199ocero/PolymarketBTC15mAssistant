
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../config.js";
import { logPaperTradeToDb } from "../db.js";
import { sendDiscordNotification } from "../net/discord.js";

const STATE_FILE = "./src/state/paperState.json";

export class PaperTrader {
  constructor(logger = null) {
    this.state = this.loadState();
    this.logger = logger;
    
    if (this.state.isNew) {
      delete this.state.isNew;
      this.saveState();
      this.log("[Paper] Initialized new state file.");
    }
  }

  log(msg) {
    if (this.logger) {
      this.logger(msg);
    } else {
      console.log(msg);
    }
  }

  loadState() {
    const defaultState = {
      balance: CONFIG.paper.initialBalance,
      positions: [], // Array of { side, amount, entryPrice, shares, marketSlug, entryTime, hitBreakevenTrigger }
      dailyLoss: 0,
      lastStopLossTime: 0,
      recentResults: [], // ['WIN', 'LOSS', ...]
      lastDailyReset: Date.now(),
      lastExitTime: 0,
      lastEntryTime: 0, // Track when we last opened a position
      consecutiveLosses: 0 // New: Track streak
    };

    try {
      if (fs.existsSync(STATE_FILE)) {
        const loaded = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
        return { ...defaultState, ...loaded };
      }
    } catch (err) {
      console.error("Failed to load paper state:", err);
    }

    return { ...defaultState, isNew: true };
  }

  saveState() {
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2), "utf8");
    } catch (err) {
      console.error("Failed to save paper state:", err);
    }
  }



  calculateFee(amount, price) {
    if (CONFIG.paper.usePolymarketDynamicFees) {
      // Polymarket Formula: fee = amount * 0.25 * (price * (1 - price))^2
      const fee = amount * 0.25 * Math.pow(price * (1 - price), 2);
      return fee;
    }
    return amount * (CONFIG.paper.feePct / 100);
  }

  async logTrade(action, side, price, amount, shares, pnl, marketSlug, fee = 0) {
    await logPaperTradeToDb({
      action,
      side,
      price,
      amount,
      shares,
      pnl,
      balance: this.state.balance,
      market_slug: marketSlug,
      fee
    });
  }

  // Called every tick
  async update({ signal, rec, prices, market, tokens, trend, timeLeftMin }) {
    if (!market || !rec) return;

    // 0. Reset Daily Loss if new day
    this.resetDailyLossIfNeeded();
    // Pass extra context for expiry check
    await this.checkResolution(market, prices, { 
      isExpired: rec.isExpired || false, 
      strikePrice: rec.strikePrice || null, 
      spotPrice: rec.spotPrice || null,
      timeLeftMin
    });

    // 2. Check Take Profit
    // We can do this before or after Entry. Usually good to check managing current pos first.
    // 2. Check Exits (TP / SL)
    await this.checkExitConditions(market, prices, { timeLeftMin: rec.timeLeftMin, trend });

    // 3. Execute Signals
    const marketSlug = market.slug;
    const priceUp = prices.up;
    const priceDown = prices.down;

    if (rec.action === "ENTER") {
      await this.handleEntrySignal(rec, rec.side, rec.strength, marketSlug, priceUp, priceDown, trend);
    }
  }

  resetDailyLossIfNeeded() {
    const last = new Date(this.state.lastDailyReset || 0);
    const now = new Date();
    // Reset if day changed (UTC)
    if (last.getUTCDate() !== now.getUTCDate()) {
      this.log(`[Paper] New day detected. Resetting Daily Loss (Prev: $${this.state.dailyLoss.toFixed(2)})`);
      this.state.dailyLoss = 0;
      this.state.lastDailyReset = now.getTime();
      this.saveState();
    }
  }

  async checkExitConditions(market, prices, { timeLeftMin, trend } = {}) {
    if (!this.state.positions || this.state.positions.length === 0) return;

    // Use a copy to iterate because we might remove items
    const activePositions = [...this.state.positions];
    
    for (const pos of activePositions) {
        if (pos.marketSlug !== market.slug) continue;
        const { side, entryPrice, entryTime } = pos;
        const price = (side === "UP" ? prices?.up : prices?.down) ?? null;
        
        if (price === null || price === undefined) continue;

        const normPrice = price > 1.05 ? price / 100 : price;
        const roi = (normPrice - entryPrice) / entryPrice;
        const roiPct = roi * 100;

        const breakevenRoi = CONFIG.paper.breakevenTriggerRoiPct || 30;
        
        const entryAgeSeconds = (Date.now() - entryTime) / 1000;
        const gracePeriod = CONFIG.paper.stopLossGracePeriodSeconds || 15;

        // 0. BREAKEVEN TRIGGER
        // 0. TIME STOP (Global vs Strategy Specific)
        // Late Window: Hold to expiration (ignore 2m rule unless emergency?)
        // Others: Exit at 2m (or Configured Time)
        const isLateWindow = pos.strategy === "LATE_WINDOW";
        const timeGuard = isLateWindow ? 0.5 : (CONFIG.paper.timeGuardMinutes || 2); 
        
        if (timeLeftMin !== undefined && timeLeftMin <= timeGuard) {
             const resThreshold = CONFIG.paper.resolutionThreshold || 0.95;
             
             // SKIP EXIT IF:
             // 1. Position is "favored" (Price > 0.50)
             const isFavored = normPrice > 0.50;
             // 2. Position is "Hopeful" (Price > 0.20 AND Trend matches side)
             const isHopeful = normPrice > 0.20 && trend === (side === "UP" ? "RISING" : "FALLING");
             // 3. Position is near resolution loss (Price < 0.05, save fees)
             const isNearLoss = normPrice <= (1 - resThreshold);

             if (isFavored || isHopeful || isNearLoss) {
                let reason = "UNSET";
                if (isFavored) reason = "FAVORED (>50¢)";
                else if (isHopeful) reason = "HOPEFUL (Trend Matching)";
                else if (isNearLoss) reason = "NEAR_LOSS (<5¢)";
                
                this.log(`[Paper] Skipping TIME_GUARD_EXIT for ${side}: ${reason} at ${normPrice.toFixed(2)} [Trend: ${trend}] in last ${(timeLeftMin*60).toFixed(0)}s`);
             } else {
                await this.closePosition(pos, price, `TIME_GUARD_EXIT (<${timeGuard}m)`);
                continue;
             }
        }

        // 1. HARD STOP LOSS (Global -40% or Strategy specific?)
        // Plan says: "Hard stop: Exit if loss reaches 40%".
        // Late window "Emergency exit: Only if BTC suddenly crashes".
        const slRoi = CONFIG.paper.stopLossRoiPct; // 40
        
        if (roiPct <= -slRoi) {
           if (entryAgeSeconds < gracePeriod) continue;
           await this.closePosition(pos, price, `STOP_LOSS (${roiPct.toFixed(1)}%)`);
           continue;
        }

        // 2. STRATEGY SPECIFIC TAKE PROFIT
        if (pos.strategy === "MOMENTUM") {
            // Target: ROI Based (User Configured, default 50%)
            if (roiPct >= (CONFIG.paper.momentumTakeProfitRoiPct || 50)) {
                await this.closePosition(pos, price, `TP_MOMENTUM (+${roiPct.toFixed(1)}%)`);
                continue;
            }
        } else if (pos.strategy === "MEAN_REVERSION") {
            // Target: Odds reach 50-60 cents (0.50 - 0.60)
            if (normPrice >= 0.50) {
                 await this.closePosition(pos, price, `TP_MEAN_REV (Price > 50¢)`);
                 continue;
            }
            // Time Stop for Mean Rev: "Exit at 3 minutes remaining"
            if (timeLeftMin <= 3) {
                 await this.closePosition(pos, price, `TIME_STOP_MEAN_REV (<3m)`);
                 continue;
            }
        } else if (pos.strategy === "LATE_WINDOW") {
            // Hold to expiration generally.
            // Profit taking is implicit at Expiry (100 or 0).
            // But if we want to lock in? "Hold until expiration".
        } else {
            // Fallback for Manual/Legacy trades
            if (roiPct >= CONFIG.paper.takeProfitRoiPct) {
                await this.closePosition(pos, price, `TAKE_PROFIT_LEGACY`);
                continue;
            }
        }

        // Breakeven protection (Global)
        // If we were up 10% and now back to 0%?
        // Plan says: "Stop Loss: If BTC reverses..."
    }
  }

  async checkResolution(market, prices, { isExpired, strikePrice, spotPrice, timeLeftMin } = {}) {
    if (!this.state.positions || this.state.positions.length === 0) return;

    const activePositions = [...this.state.positions];
    for (const pos of activePositions) {
      // 1. Check for expiration based on stored endDate or passed timeLeftMin
      const posExpired = (timeLeftMin !== undefined && timeLeftMin <= 0) || 
                         (pos.endDate && Date.now() >= pos.endDate);
      
      const posStrike = pos.strikePrice || strikePrice;
      const posSpot = spotPrice; // Current market spot price

      if (posExpired && posStrike !== null && posSpot !== null) {
        const side = pos.side;
        let win = false;
        if (side === "UP") win = posSpot >= posStrike;
        else if (side === "DOWN") win = posSpot < posStrike;
        
        // Use 1 or 0 for exit price to implement the $1.00 implementation properly
        await this.closePosition(pos, win ? 1 : 0, `EXPIRY (Spot: ${posSpot}, Strike: ${posStrike})`);
      }
    }
  }

  getUnrealizedPnL(prices) {
    if (!this.state.positions || this.state.positions.length === 0) return 0;
    
    let totalPnl = 0;
    for (const pos of this.state.positions) {
        let currentPrice = pos.side === "UP" ? prices.up : prices.down;
        if (currentPrice === null || currentPrice === undefined) continue;
        
        const normalizedCurr = currentPrice > 1.05 ? currentPrice / 100 : currentPrice;
        const currentValue = pos.shares * normalizedCurr;
        totalPnl += (currentValue - pos.amount);
    }
    return totalPnl;
  }

  async closePosition(pos, exitPrice, reason) {
    const { side, shares, amount, marketSlug } = pos;
    
    const normalizedExit = exitPrice > 1.05 ? exitPrice / 100 : exitPrice;
    let proceeds = shares * normalizedExit;
    
    let fee = 0;
    if (reason !== "EXPIRY" && reason !== "SETTLE") {
        fee = this.calculateFee(proceeds, normalizedExit);
        proceeds -= fee;
    }

    const pnl = proceeds - amount;
    this.state.balance += proceeds;
    
    if (pnl < 0) {
        this.state.dailyLoss = (this.state.dailyLoss || 0) + Math.abs(pnl);
        this.state.recentResults = [...(this.state.recentResults || []), "LOSS"].slice(-10);
        if (reason.includes("STOP_LOSS")) {
            this.state.lastStopLossTime = Date.now();
        }
        this.state.consecutiveLosses = (this.state.consecutiveLosses || 0) + 1;
    } else {
        this.state.dailyLoss = (this.state.dailyLoss || 0) - pnl;
        this.state.recentResults = [...(this.state.recentResults || []), "WIN"].slice(-10);
        this.state.consecutiveLosses = 0;
    }

    await this.logTrade(reason, side, exitPrice, amount, shares, pnl, marketSlug, fee);

    sendDiscordNotification({
      type: pnl >= 0 ? "WIN" : "LOSS",
      side,
      price: exitPrice,
      shares,
      pnl,
      balance: this.state.balance,
      marketSlug,
      reason,
      amount: proceeds,
      fee
    });

    // Remove from array
    this.state.positions = this.state.positions.filter(p => p !== pos);
    
    // For Penalty Box: Reverted as it backfired (Phase 7). 
    // We now rely on Max Concurrent = 2 to limit damage.
    this.state.lastExitTime = Date.now();

    this.saveState();
    this.log(`[Paper] Closed ${side} at ${exitPrice} (${reason}). PnL: $${pnl.toFixed(2)} (Fee: $${fee.toFixed(2)}) DailyNetLoss: $${this.state.dailyLoss.toFixed(2)}`);
  }

  async handleEntrySignal(rec, side, confidence, marketSlug, priceUp, priceDown, trend) {
    const currentPos = this.state.position;
    
    // Price safety
    const entryPrice = side === "UP" ? priceUp : priceDown;
    if (!entryPrice || entryPrice <= 0 || entryPrice >= 1) return;
    const normalizedPrice = entryPrice > 1 ? entryPrice / 100 : entryPrice;
    
    // Default Trade Amount (Manual Override fallback)
    let tradeAmount = CONFIG.paper.maxBet; 

    // --- FILTERS & CHECKS ---
    
    // 0. Price Guard (Lottery Ticket Prevention)
    if (normalizedPrice < CONFIG.paper.minEntryPrice || normalizedPrice > CONFIG.paper.maxEntryPrice) {
        this.log(`[Paper] Blocked Entry: Price ${normalizedPrice.toFixed(2)} out of range (${CONFIG.paper.minEntryPrice}-${CONFIG.paper.maxEntryPrice})`);
        return;
    }

    // 0b. Consecutive Loss Circuit Breaker
    if ((this.state.consecutiveLosses || 0) >= CONFIG.paper.maxConsecutiveLosses) {
        this.log(`[Paper] Blocked Entry: Max consecutive losses reached (${this.state.consecutiveLosses}). Manual reset required.`);
        return; 
    }

    // 0c. Duplicate Position Guard
    if (this.state.position && this.state.position.marketSlug === marketSlug) {
         // console.log(`[Paper] Blocked Entry: Already have a position in ${marketSlug}.`);
         return;
    }
    
    // Log Probability for debugging
    if (rec) {
       this.log(`[Probability] Strategy: ${rec.strategy} Market: ${normalizedPrice.toFixed(2)} Confidence: ${rec.confidence}`);
    }

    // 1. Daily Loss Limit
    // Percentage-based: 30% of current balance
    const dailyLossLimit = this.state.balance * (CONFIG.paper.dailyLossLimitPct / 100);
    if ((this.state.dailyLoss || 0) >= dailyLossLimit) {
        // Only log once per minute to avoid spam? Or just return silent?
        // console.log("[Paper] Daily Loss Limit Hit. No new trades.");
        return;
    }

    // 2. Cooldown after Stop Loss
    if (this.state.lastStopLossTime) {
        const msSince = Date.now() - this.state.lastStopLossTime;
        const minsSince = msSince / 60000;
        if (minsSince < CONFIG.paper.cooldownMinutes) {
            // console.log(`[Paper] Cooldown active (${minsSince.toFixed(1)}m / ${CONFIG.paper.cooldownMinutes}m).`);
            return;
        }
    }

    // 2b. Entry Debounce
    if (this.state.lastEntryTime) {
        const msSinceEntry = Date.now() - this.state.lastEntryTime;
        const entryDebounceMs = (CONFIG.paper.entryCooldownSeconds || 15) * 1000;
        if (msSinceEntry < entryDebounceMs) {
            // console.log(`[Paper] Entry Debounce active (${(msSinceEntry/1000).toFixed(0)}s < ${CONFIG.paper.entryCooldownSeconds}s)`);
            return;
        }
    }

    // 3. Trend Filter (Momentum already checks this, but keep as safety?)
    // If strategy is "MEAN_REVERSION" (Counter trend), we might ignore this?
    // User plan: "Momentum... EMA 21 confirms trend".
    // Strategy logic already enforced trend.
    // If we have a signal, we trust the strategy.
    
    // 4. Position Sizing (Kelly Criterion or Fixed $3-5 based on conviction)
    
    if (CONFIG.paper.useKelly && rec.probability !== undefined) {
        const p = rec.probability;
        const b = this.state.balance;
        const price = normalizedPrice;
        const f = CONFIG.paper.kellyFraction || 0.5;
        
        // Kelly Formula for Binary Options: (p * (b + 1) - 1) / b 
        // where b is the odds (payout per $1 bet). 
        // On Polymarket, if you buy at $0.60, you win $1.00 ($0.40 profit).
        // b = profit / cost = (1 - price) / price
        // Simplified Kelly: (p - price) / (1 - price)
        
        const kelly = (p - price) / (1 - price);
        const kellyAmount = b * f * kelly;
        
        tradeAmount = Math.max(CONFIG.paper.minKellyBet, Math.min(CONFIG.paper.maxKellyBet, kellyAmount));
        
        this.log(`[Kelly] Prob: ${p.toFixed(2)} Price: ${price.toFixed(2)} Kelly: ${kelly.toFixed(2)} -> $${tradeAmount.toFixed(2)}`);
    } else {
        // Fixed Sizing (Legacy)
        if (rec.strategy === "LATE_WINDOW") tradeAmount = 5;
        else if (rec.strategy === "MOMENTUM") tradeAmount = 4;
        else if (rec.strategy === "MEAN_REVERSION") tradeAmount = 3;
        else tradeAmount = CONFIG.paper.minBet; // Fallback
    }

     // FLIP FLOP LOGIC (Reversal)
     const marketPositions = this.state.positions.filter(p => p.marketSlug === marketSlug);
     if (marketPositions.length > 0) {
       if (marketPositions[0].side !== side) {
         this.log(`[Paper] FLIPPING POSITIONS: ${marketPositions[0].side} -> ${side}`);
         for (const pos of marketPositions) {
             await this.closePosition(pos, (side === "UP" ? priceUp : priceDown), "FLIP_CLOSE");
         }
       }
     }
 
     // OPEN NEW POSITION (Balanced Stacking - Power of 2)
     const maxPos = CONFIG.paper.maxConcurrentPositions || 2;
     if (this.state.positions.length < maxPos && this.state.balance >= tradeAmount) {
        const shares = tradeAmount / normalizedPrice;
        const fee = this.calculateFee(tradeAmount, normalizedPrice);
        const totalCost = tradeAmount + fee;
 
        this.state.balance -= totalCost;
        this.state.positions.push({
          marketSlug,
          side,
          entryPrice: normalizedPrice,
          amount: totalCost,
          shares,
          entryTime: Date.now(),
          hitBreakevenTrigger: false,
          strategy: rec.strategy || "UNKNOWN",
          strikePrice: rec.strikePrice || null,
          endDate: rec.endDate || null
        });
        
        this.state.lastEntryTime = Date.now(); // Track entry for debounce
        
        await this.logTrade("OPEN", side, entryPrice, tradeAmount, shares, null, marketSlug, fee);
        
        // Discord Notification
        sendDiscordNotification({
          type: "OPEN",
          side,
          price: entryPrice,
          shares,
          amount: tradeAmount, // Cost
          balance: this.state.balance,
          marketSlug,
          fee
        });
 
        this.saveState();
        this.log(`[Paper] Entered ${side} at ${entryPrice} (Amt: $${tradeAmount} + Fee: $${fee.toFixed(2)}) Strategy: ${rec.strategy}`);
     } else if (this.state.balance < tradeAmount) {
       this.log("[Paper] Insufficient balance for trade.");
     }
  }
  getBlockingReason(side, trend) {
    // 1. Daily Loss Limit
    const dailyLossLimit = this.state.balance * (CONFIG.paper.dailyLossLimitPct / 100);
    if ((this.state.dailyLoss || 0) >= dailyLossLimit) {
      return "Daily Loss Limit (%)";
    }

    // 2. Penalty Box / Cooldown Logic: Reverted in Phase 7 to prioritize recovery trades.
    // We strictly use the 15s entry debounce (below) and max 2 positions.

    // 2b. Entry Debounce (15 Seconds)
    if (this.state.lastEntryTime) {
        const msSinceEntry = Date.now() - this.state.lastEntryTime;
        const entryDebounceMs = (CONFIG.paper.entryCooldownSeconds || 15) * 1000;
        if (msSinceEntry < entryDebounceMs) {
            const remaining = Math.ceil((entryDebounceMs - msSinceEntry) / 1000);
            return `Entry Debounce (${remaining}s)`;
        }
    }

    // 3. Trend Filter
    if (trend === "FALLING" && side === "UP") {
      return "Trend (Falling vs Up)";
    }
    if (trend === "RISING" && side === "DOWN") {
      return "Trend (Rising vs Down)";
    }

    // 4. Insufficient Balance (Estimate based on Min Bet)
    // We don't know the exact price here easily without passing it, but we can check raw balance vs minBet
    if (this.state.balance < CONFIG.paper.minBet) {
       return "Insufficient Balance";
    }

    return null; // Not blocked
  }
}
