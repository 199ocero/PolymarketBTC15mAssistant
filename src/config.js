export const CONFIG = {
  symbol: "BTCUSDT",
  binanceBaseUrl: "https://data-api.binance.vision",
  gammaBaseUrl: "https://gamma-api.polymarket.com",
  clobBaseUrl: "https://clob.polymarket.com",

  pollIntervalMs: 1_000,
  candleWindowMinutes: 15,

  // Indicators
  vwapSlopeLookbackMinutes: 5,
  rsiPeriod: 14,
  rsiMaPeriod: 14,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,

  // Strategy Specifics
  strategy: {
    momentum: {
      rsiMin: 55,
      rsiMax: 65, // for Uptrend check
      rsiMinDown: 35, 
      rsiMaxDown: 45, // for Downtrend check (symmetrical tightly around 50)
      minOddsEdge: 0.15, // 15%
    },
    meanReversion: {
      rsiOverbought: 65,
      rsiOversold: 35,
      vwapDeviation: 0.003, // 0.3%
      minTimeRemaining: 7,
    },
    lateWindow: {
      maxTimeRemaining: 1.5, // 90 seconds
      minTimeRemaining: 1.0, // 60 seconds
      minOdds: 0.85, // safe barrier
    }
  },

  polymarket: {
    marketSlug: process.env.POLYMARKET_SLUG || "",
    seriesId: process.env.POLYMARKET_SERIES_ID || "10192",
    seriesSlug: process.env.POLYMARKET_SERIES_SLUG || "btc-up-or-down-15m",
    autoSelectLatest: (process.env.POLYMARKET_AUTO_SELECT_LATEST || "true").toLowerCase() === "true",
    liveDataWsUrl: process.env.POLYMARKET_LIVE_WS_URL || "wss://ws-live-data.polymarket.com",
    upOutcomeLabel: process.env.POLYMARKET_UP_LABEL || "Up",
    downOutcomeLabel: process.env.POLYMARKET_DOWN_LABEL || "Down",
    heavyFetchIntervalMs: 5_000 
  },

  chainlink: {
    polygonRpcUrls: (process.env.POLYGON_RPC_URLS || "").split(",").map((s) => s.trim()).filter(Boolean),
    polygonRpcUrl: process.env.POLYGON_RPC_URL || "https://polygon-rpc.com",
    polygonWssUrls: (process.env.POLYGON_WSS_URLS || "").split(",").map((s) => s.trim()).filter(Boolean),
    polygonWssUrl: process.env.POLYGON_WSS_URL || "",
    btcUsdAggregator: process.env.CHAINLINK_BTC_USD_AGGREGATOR || "0xc907E116054Ad103354f2D350FD2514433D57F6f"
  },

  paper: {
    initialBalance: Number(process.env.PAPER_BALANCE) || 100,
    feePct: 2.0, // Fallback if dynamic off
    usePolymarketDynamicFees: true,

    // Execution / Risk
    minBet: 3, // $3
    maxBet: 5, // $5 (per trade position size)
    maxConcurrentPositions: 2, // Power of 2
    
    // Stop Loss & Take Profit
    // "Momentum: 15-20 cents", "MeanRev: 50-60 cents" -> Target fixed price usually
    // Hard stop -40%
    stopLossRoiPct: 40.0, 
    takeProfitRoiPct: 100.0, // High ceiling, strategy exits logic handles dynamic TP (15c, 20c gain etc)
    momentumTakeProfitRoiPct: 50.0, // Target ROI for Momentum Strategy
    
    // Limits
    maxTradesPerDay: 50,
    dailyLossLimit: 15.0, // Deprecated - replaced by dailyLossLimitPct
    dailyLossLimitPct: 30.0, // 30% of fund
    
    // Kelly Criterion
    useKelly: true,
    kellyFraction: 0.5, // Half-Kelly for stability
    minKellyBet: 3, // $3
    maxKellyBet: 5, // $5 (per trade position size)

    // Misc
    breakevenTriggerRoiPct: 10.0, // maybe keep generic
    timeGuardMinutes: 2, // "Exit all positions with 2 mins remaining"
    resolutionThreshold: 0.95, // Exit skip threshold (95 cents or 5 cents)
    resolutionWindowMin: 1.5, // 90 seconds
    
    entryCooldownSeconds: 45, // "Wait at least 45 seconds between entering new trades"
    stopLossGracePeriodSeconds: 15,
  },
  discord: {
    webhookUrl: process.env.DISCORD_WEBHOOK_URL || ""
  }
};
