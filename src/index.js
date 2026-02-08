import { CONFIG } from "./config.js";
import { fetchKlines, fetchLastPrice } from "./data/binance.js";
import { fetchChainlinkBtcUsd } from "./data/chainlink.js";
import { startChainlinkPriceStream } from "./data/chainlinkWs.js";
import { startPolymarketChainlinkPriceStream } from "./data/polymarketLiveWs.js";
import { logSignalToDb, getWinStats, getRecentTrades } from "./db.js";
import {
  fetchMarketBySlug,
  fetchLiveEventsBySeriesId,
  flattenEventMarkets,
  pickLatestLiveMarket,
  fetchClobPrice,
  fetchOrderBook,
  summarizeOrderBook
} from "./data/polymarket.js";
import { computeSessionVwap, computeVwapSeries } from "./indicators/vwap.js";
import { computeRsi, sma, slopeLast } from "./indicators/rsi.js";
import { computeMacd } from "./indicators/macd.js";
import { computeHeikenAshi, countConsecutive } from "./indicators/heikenAshi.js";
import { computeEma } from "./indicators/ema.js";
import { detectRegime } from "./engines/regime.js";
import { scoreDirection, applyTimeAwareness } from "./engines/probability.js";
import { computeEdge, decide } from "./engines/edge.js";
import { appendCsvRow, formatNumber, formatPct, getCandleWindowTiming, sleep } from "./utils.js";
import { startBinanceTradeStream } from "./data/binanceWs.js";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { applyGlobalProxyFromEnv } from "./net/proxy.js";
import { PaperTrader } from "./engines/paperTrader.js";
import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

function countVwapCrosses(closes, vwapSeries, lookback) {
  if (closes.length < lookback || vwapSeries.length < lookback) return null;
  let crosses = 0;
  for (let i = closes.length - lookback + 1; i < closes.length; i += 1) {
    const prev = closes[i - 1] - vwapSeries[i - 1];
    const cur = closes[i] - vwapSeries[i];
    if (prev === 0) continue;
    if ((prev > 0 && cur < 0) || (prev < 0 && cur > 0)) crosses += 1;
  }
  return crosses;
}

applyGlobalProxyFromEnv();

// --- WEB SERVER & WS SETUP ---
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static("public"));

const clients = new Set();
wss.on("connection", (ws) => {
  clients.add(ws);
  
  // Send last state immediately if available
  if (lastState) {
    ws.send(JSON.stringify(lastState));
  }
  
  ws.on("close", () => clients.delete(ws));
});

let lastState = null;

function broadcast(data) {
  if (data.type === "state") {
    lastState = data;
  }
  const msg = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\x1b[36m[System] Web Dashboard starting at http://localhost:${PORT}\x1b[0m`);
});

function fmtTimeLeft(mins) {
  const totalSeconds = Math.max(0, Math.floor(mins * 60));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ANSI = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  lightRed: "\x1b[91m",
  gray: "\x1b[90m",
  white: "\x1b[97m",
  dim: "\x1b[2m"
};

function screenWidth() {
  const w = Number(process.stdout?.columns);
  return Number.isFinite(w) && w >= 40 ? w : 80;
}

function sepLine(ch = "─") {
  const w = screenWidth();
  return `${ANSI.white}${ch.repeat(w)}${ANSI.reset}`;
}

function renderScreen(text) {
  try {
    readline.cursorTo(process.stdout, 0, 0);
    readline.clearScreenDown(process.stdout);
  } catch {
    // ignore
  }
  process.stdout.write(text);
}

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

function padLabel(label, width) {
  const visible = stripAnsi(label).length;
  if (visible >= width) return label;
  return label + " ".repeat(width - visible);
}

function centerText(text, width) {
  const visible = stripAnsi(text).length;
  if (visible >= width) return text;
  const left = Math.floor((width - visible) / 2);
  const right = width - visible - left;
  return " ".repeat(left) + text + " ".repeat(right);
}

const LABEL_W = 16;
function kv(label, value) {
  const l = padLabel(String(label), LABEL_W);
  return `${l}${value}`;
}

function section(title) {
  return `${ANSI.white}${title}${ANSI.reset}`;
}

function colorPriceLine({ label, price, prevPrice, decimals = 0, prefix = "" }) {
  if (price === null || price === undefined) {
    return `${label}: ${ANSI.gray}-${ANSI.reset}`;
  }

  const p = Number(price);
  const prev = prevPrice === null || prevPrice === undefined ? null : Number(prevPrice);

  let color = ANSI.reset;
  let arrow = "";
  if (prev !== null && Number.isFinite(prev) && Number.isFinite(p) && p !== prev) {
    if (p > prev) {
      color = ANSI.green;
      arrow = " ↑";
    } else {
      color = ANSI.red;
      arrow = " ↓";
    }
  }

  const formatted = `${prefix}${formatNumber(p, decimals)}`;
  return `${label}: ${color}${formatted}${arrow}${ANSI.reset}`;
}

function formatSignedDelta(delta, base) {
  if (delta === null || base === null || base === 0) return `${ANSI.gray}-${ANSI.reset}`;
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
  const pct = (Math.abs(delta) / Math.abs(base)) * 100;
  return `${sign}$${Math.abs(delta).toFixed(2)}, ${sign}${pct.toFixed(2)}%`;
}

function colorByNarrative(text, narrative) {
  if (narrative === "LONG") return `${ANSI.green}${text}${ANSI.reset}`;
  if (narrative === "SHORT") return `${ANSI.red}${text}${ANSI.reset}`;
  return `${ANSI.gray}${text}${ANSI.reset}`;
}

function formatNarrativeValue(label, value, narrative) {
  return `${label}: ${colorByNarrative(value, narrative)}`;
}

function narrativeFromSign(x) {
  if (x === null || x === undefined || !Number.isFinite(Number(x)) || Number(x) === 0) return "NEUTRAL";
  return Number(x) > 0 ? "LONG" : "SHORT";
}

function narrativeFromRsi(rsi) {
  if (rsi === null || rsi === undefined || !Number.isFinite(Number(rsi))) return "NEUTRAL";
  const v = Number(rsi);
  if (v >= 55) return "LONG";
  if (v <= 45) return "SHORT";
  return "NEUTRAL";
}

function narrativeFromSlope(slope) {
  if (slope === null || slope === undefined || !Number.isFinite(Number(slope)) || Number(slope) === 0) return "NEUTRAL";
  return Number(slope) > 0 ? "LONG" : "SHORT";
}

function formatProbPct(p, digits = 0) {
  if (p === null || p === undefined || !Number.isFinite(Number(p))) return "-";
  return `${(Number(p) * 100).toFixed(digits)}%`;
}

function fmtEtTime(now = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(now);
  } catch {
    return "-";
  }
}

function getBtcSession(now = new Date()) {
  const h = now.getUTCHours();
  const inAsia = h >= 0 && h < 8;
  const inEurope = h >= 7 && h < 16;
  const inUs = h >= 13 && h < 22;

  if (inEurope && inUs) return "Europe/US overlap";
  if (inAsia && inEurope) return "Asia/Europe overlap";
  if (inAsia) return "Asia";
  if (inEurope) return "Europe";
  if (inUs) return "US";
  return "Off-hours";
}

function parsePriceToBeat(market) {
  const text = String(market?.question ?? market?.title ?? "");
  if (!text) return null;
  
  // 1. Explicit "Price to beat"
  let m = text.match(/price\s*to\s*beat[^\d$]*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
  
  // 2. "> Value" (e.g. BTC > 100,000)
  if (!m) {
    m = text.match(/>\s*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/);
  }

  // 3. "Above Value"
  if (!m) {
    m = text.match(/above\s*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
  }

  if (!m) return null;
  const raw = m[1].replace(/,/g, "");
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

const dumpedMarkets = new Set();

function safeFileSlug(x) {
  return String(x ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 120);
}

function extractNumericFromMarket(market) {
  const directKeys = [
    "priceToBeat",
    "price_to_beat",
    "strikePrice",
    "strike_price",
    "strike",
    "threshold",
    "thresholdPrice",
    "threshold_price",
    "targetPrice",
    "target_price",
    "referencePrice",
    "reference_price"
  ];

  for (const k of directKeys) {
    const v = market?.[k];
    const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
    if (Number.isFinite(n)) return n;
  }

  const seen = new Set();
  const stack = [{ obj: market, depth: 0 }];

  while (stack.length) {
    const { obj, depth } = stack.pop();
    if (!obj || typeof obj !== "object") continue;
    if (seen.has(obj) || depth > 6) continue;
    seen.add(obj);

    const entries = Array.isArray(obj) ? obj.entries() : Object.entries(obj);
    for (const [key, value] of entries) {
      const k = String(key).toLowerCase();
      if (value && typeof value === "object") {
        stack.push({ obj: value, depth: depth + 1 });
        continue;
      }

      if (!/(price|strike|threshold|target|beat)/i.test(k)) continue;

      const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
      if (!Number.isFinite(n)) continue;

      if (n > 1000 && n < 2_000_000) return n;
    }
  }

  return null;
}

function priceToBeatFromPolymarketMarket(market) {
  const n = extractNumericFromMarket(market);
  if (n !== null) return n;
  return parsePriceToBeat(market);
}

const marketCache = {
  market: null,
  fetchedAtMs: 0
};

const orderBookCache = {
  up: null,
  down: null,
  fetchedAtMs: 0
};

async function resolveCurrentBtc15mMarket() {
  if (CONFIG.polymarket.marketSlug) {
    return await fetchMarketBySlug(CONFIG.polymarket.marketSlug);
  }

  if (!CONFIG.polymarket.autoSelectLatest) return null;

  const now = Date.now();
  // Use heavyFetchIntervalMs for market metadata instead of pollIntervalMs
  const expiration = CONFIG.polymarket.heavyFetchIntervalMs || 5000;
  
  if (marketCache.market && now - marketCache.fetchedAtMs < expiration) {
    return marketCache.market;
  }

  const events = await fetchLiveEventsBySeriesId({ seriesId: CONFIG.polymarket.seriesId, limit: 25 });
  const markets = flattenEventMarkets(events);
  const picked = pickLatestLiveMarket(markets);

  marketCache.market = picked;
  marketCache.fetchedAtMs = now;
  return picked;
}

async function fetchPolymarketSnapshot() {
  const market = await resolveCurrentBtc15mMarket();

  if (!market) return { ok: false, reason: "market_not_found" };

  const outcomes = Array.isArray(market.outcomes) ? market.outcomes : (typeof market.outcomes === "string" ? JSON.parse(market.outcomes) : []);
  const outcomePrices = Array.isArray(market.outcomePrices)
    ? market.outcomePrices
    : (typeof market.outcomePrices === "string" ? JSON.parse(market.outcomePrices) : []);

  const clobTokenIds = Array.isArray(market.clobTokenIds)
    ? market.clobTokenIds
    : (typeof market.clobTokenIds === "string" ? JSON.parse(market.clobTokenIds) : []);

  let upTokenId = null;
  let downTokenId = null;
  for (let i = 0; i < outcomes.length; i += 1) {
    const label = String(outcomes[i]);
    const tokenId = clobTokenIds[i] ? String(clobTokenIds[i]) : null;
    if (!tokenId) continue;

    if (label.toLowerCase() === CONFIG.polymarket.upOutcomeLabel.toLowerCase()) upTokenId = tokenId;
    if (label.toLowerCase() === CONFIG.polymarket.downOutcomeLabel.toLowerCase()) downTokenId = tokenId;
  }

  const upIndex = outcomes.findIndex((x) => String(x).toLowerCase() === CONFIG.polymarket.upOutcomeLabel.toLowerCase());
  const downIndex = outcomes.findIndex((x) => String(x).toLowerCase() === CONFIG.polymarket.downOutcomeLabel.toLowerCase());

  const gammaYes = upIndex >= 0 ? Number(outcomePrices[upIndex]) : null;
  const gammaNo = downIndex >= 0 ? Number(outcomePrices[downIndex]) : null;

  if (!upTokenId || !downTokenId) {
    return {
      ok: false,
      reason: "missing_token_ids",
      market,
      outcomes,
      clobTokenIds,
      outcomePrices
    };
  }

  let upBuy = null;
  let downBuy = null;
  let upBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null };
  let downBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null };

  try {
    const promises = [
      fetchClobPrice({ tokenId: upTokenId, side: "buy" }),
      fetchClobPrice({ tokenId: downTokenId, side: "buy" })
    ];

    // Only fetch orderbook if cache expired
    const now = Date.now();
    const obExpiration = CONFIG.polymarket.heavyFetchIntervalMs || 5000;
    const shouldFetchBook = now - orderBookCache.fetchedAtMs > obExpiration;

    if (shouldFetchBook) {
        promises.push(fetchOrderBook({ tokenId: upTokenId }));
        promises.push(fetchOrderBook({ tokenId: downTokenId }));
    }

    const results = await Promise.all(promises);
    const yesBuy = results[0];
    const noBuy = results[1];
    
    let upBook, downBook;

    if (shouldFetchBook) {
        upBook = results[2];
        downBook = results[3];
        orderBookCache.up = upBook;
        orderBookCache.down = downBook;
        orderBookCache.fetchedAtMs = now;
    } else {
        upBook = orderBookCache.up;
        downBook = orderBookCache.down;
    }

    upBuy = yesBuy;
    downBook = downBook; // fix naming if needed? No, logic below uses summaries.
    downBuy = noBuy;
    upBookSummary = summarizeOrderBook(upBook);
    downBookSummary = summarizeOrderBook(downBook);
  } catch {
    upBuy = null;
    downBuy = null;
    upBookSummary = {
      bestBid: Number(market.bestBid) || null,
      bestAsk: Number(market.bestAsk) || null,
      spread: Number(market.spread) || null,
      bidLiquidity: null,
      askLiquidity: null
    };
    downBookSummary = {
      bestBid: null,
      bestAsk: null,
      spread: Number(market.spread) || null,
      bidLiquidity: null,
      askLiquidity: null
    };
  }

  return {
    ok: true,
    market,
    tokens: { upTokenId, downTokenId },
    prices: {
      up: upBuy ?? gammaYes,
      down: downBuy ?? gammaNo
    },
    orderbook: {
      up: upBookSummary,
      down: downBookSummary
    }
  };
}

async function main() {
  if (!global.binanceStream) global.binanceStream = startBinanceTradeStream({ symbol: CONFIG.symbol });
  if (!global.polymarketLiveStream) global.polymarketLiveStream = startPolymarketChainlinkPriceStream({});
  if (!global.chainlinkStream) global.chainlinkStream = startChainlinkPriceStream({});

  const binanceStream = global.binanceStream;
  const polymarketLiveStream = global.polymarketLiveStream;
  const chainlinkStream = global.chainlinkStream;

  let prevSpotPrice = null;
  let prevCurrentPrice = null;
  let priceToBeatState = { slug: null, value: null, setAtMs: null };
  const signalState = { lastSide: null, lastTime: 0 };
  
  const activityLog = [];
  let lastLogMsg = null;
  const pushActivity = (msg) => {
    if (msg === lastLogMsg) return;
    lastLogMsg = msg;
    const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
    activityLog.push(`${ANSI.gray}[${timestamp}]${ANSI.reset} ${msg}`);
    if (activityLog.length > 8) activityLog.shift();
    
    // Broadcast to Web UI
    let type = 'default';
    if (msg.includes('WIN')) type = 'win';
    else if (msg.includes('LOSS')) type = 'loss';
    else if (msg.includes('System')) type = 'system';
    
    broadcast({ type: 'activity', payload: { msg, type } });
  };

  const paper = new PaperTrader(pushActivity);
  let lastStrikeCheckTime = 0;
  let consecutiveErrors = 0;

  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[?25l"); // Hide cursor
    console.clear();
  }

  pushActivity(`System: PolyBot Dashboard Live at http://localhost:${PORT}`);

  // Main Loop State
  let tickCount = 0;
  
  // Safe Performance Optimization: 250ms ticks
  const LOOP_INTERVAL_MS = 250;
  const SLOW_TICKS = 8; // 8 * 250ms = 2s

  // Initialize cached analysis to avoid empty UI on first tick
  if (!global.lastAnalysis) global.lastAnalysis = {};

  while (true) {
    try {
      const timing = getCandleWindowTiming(CONFIG.candleWindowMinutes);

    // 1. Fetch Fast Data (Every Tick)
    const wsTick = binanceStream.getLast();
    let spotPrice = wsTick?.price ?? prevSpotPrice;

    // Fetch Binance REST if WS is missing (Throttled fallback)
    if (spotPrice === null && tickCount % (SLOW_TICKS * 5) === 0) { // Every ~10s
        try {
            const res = await fetchLastPrice();
            if (res) spotPrice = res;
        } catch (err) {
            // ignore
        }
    }

    const polymarketWsTick = polymarketLiveStream.getLast();
    const polymarketWsPrice = polymarketWsTick?.price ?? null;

    const chainlinkWsTick = chainlinkStream.getLast();
    const chainlinkWsPrice = chainlinkWsTick?.price ?? null;

    // Fetch Chainlink if WS is missing (Throttled fallback)
    let chainlinkPrice = chainlinkWsPrice ?? polymarketWsPrice;
    if (chainlinkPrice === null && tickCount % (SLOW_TICKS * 5) === 0) { // Every ~10s
        const res = await fetchChainlinkBtcUsd();
        if (res) chainlinkPrice = res.price;
    }
    const currentPrice = chainlinkPrice ?? prevCurrentPrice;

    // --- SLOW DATA (Throttled) ---
    const isSlowTick = (tickCount % SLOW_TICKS === 0) || (tickCount === 0);
    
    // Fetch Poly Snapshot (Throttled)
    let poly = global.lastPolyResult;
    if (isSlowTick) {
         poly = await fetchPolymarketSnapshot();
         global.lastPolyResult = poly;
    }
    if (!poly) poly = { ok: false, prices: { up: null, down: null } };

    // Fetch Candles (Throttled)
    let klines1m = [];
    let fetchedLastPrice = null;
    
    if (isSlowTick) {
        klines1m = await fetchKlines({ interval: "1m", limit: 240 });
        fetchedLastPrice = await fetchLastPrice();
    }
    
    const lastPrice = fetchedLastPrice || prevSpotPrice;

    // State persistence
    prevSpotPrice = spotPrice ?? prevSpotPrice;
    prevCurrentPrice = currentPrice ?? prevCurrentPrice;

    // --- CRITICAL: Strategy Logic (Throttled) ---
      
    // 0. CHECK FOR MANUAL STRIKE OVERRIDE (Poll every 5s - approx 20 ticks)
    if (tickCount % 20 === 0) {
        const strikeFile = "strike.txt";
        if (fs.existsSync(strikeFile)) {
          try {
            const content = fs.readFileSync(strikeFile, "utf8").trim();
            const overridePrice = parseFloat(content.replace(/,/g, ""));
            if (Number.isFinite(overridePrice) && overridePrice > 0) {
                if (priceToBeatState.value !== overridePrice) {
                  priceToBeatState = { slug: poly.market?.slug || "manual", value: overridePrice, setAtMs: Date.now() };
                }
            }
          } catch (err) {
              // ignore
          }
        }
      }

      // Logic for Strike Price Latching (Needs Poly Market Data)
      if (poly.ok && poly.market) {
          const marketSlug = String(poly.market.slug ?? "");
          const marketStartMs = poly.market.eventStartTime ? new Date(poly.market.eventStartTime).getTime() : null;
          
          if (marketSlug && priceToBeatState.slug !== marketSlug) {
            priceToBeatState = { slug: marketSlug, value: null, setAtMs: null };
          }
          if (priceToBeatState.slug && priceToBeatState.value === null && currentPrice !== null) {
              const metaStrike = priceToBeatFromPolymarketMarket(poly.market);
              if (metaStrike !== null && Number.isFinite(metaStrike)) {
                 priceToBeatState = { slug: priceToBeatState.slug, value: metaStrike, setAtMs: Date.now() };
              } else {
                 const nowMs = Date.now();
                 const okToLatch = marketStartMs === null ? true : nowMs >= marketStartMs;
                 if (okToLatch) {
                    priceToBeatState = { slug: priceToBeatState.slug, value: Number(currentPrice), setAtMs: nowMs };
                 }
              }
          }
      }
      const priceToBeat = priceToBeatState.value;

      // --- GAP CALCULATION (Redefined) ---
      // 1. binanceGap = Binance WS - Binance REST (Old "gap", mostly for magnet/internal logic)
      const binanceGap = (spotPrice !== null && lastPrice !== null) ? spotPrice - lastPrice : null;
      
      // 2. uiGap = Chainlink - Strike (New "Gap" for user)
      const uiGap = (currentPrice !== null && priceToBeat !== null) ? currentPrice - priceToBeat : null;

      // Fetch Recent Trades (Throttled)
      let recentTrades = global.lastAnalysis?.recentTrades || [];
      let winStats = global.lastAnalysis?.winStats || { winsToday: 0, totalToday: 0, winsAll: 0, totalAll: 0 };
      
      // Fire-and-forget update to prevent main loop blocking
      if (isSlowTick) {
          getWinStats().then(stats => {
             winStats = stats;
             if (global.lastAnalysis) global.lastAnalysis.winStats = stats;
          }).catch(err => {
             // ignore
          });
      }

      if (isSlowTick) {
          getRecentTrades(5).then(trades => {
              recentTrades = trades;
              if (global.lastAnalysis) global.lastAnalysis.recentTrades = trades;
          }).catch(err => {
              // ignore
          });
      }

      // If Slow Tick, Run Strategy
      if (isSlowTick && klines1m.length > 0) {
          // Reconstruct variables needed for strategy
          const candles = klines1m;
          const closes = candles.map((c) => c.close);
          const vwap = computeSessionVwap(candles);
          const vwapSeries = computeVwapSeries(candles);
          const vwapNow = vwapSeries[vwapSeries.length - 1];
          const lookback = CONFIG.vwapSlopeLookbackMinutes;
          const vwapSlope = vwapSeries.length >= lookback ? (vwapNow - vwapSeries[vwapSeries.length - lookback]) / lookback : null;
          const vwapCrossCount = countVwapCrosses(closes, vwapSeries, 20);
          
          const rsiNow = computeRsi(closes, CONFIG.rsiPeriod);
          const rsiSeries = [];
          for (let i = 0; i < closes.length; i += 1) {
            const sub = closes.slice(0, i + 1);
            const r = computeRsi(sub, CONFIG.rsiPeriod);
            if (r !== null) rsiSeries.push(r);
          }
          const rsiSlope = slopeLast(rsiSeries, 3);
          const macd = computeMacd(closes, CONFIG.macdFast, CONFIG.macdSlow, CONFIG.macdSignal);
          const ha = computeHeikenAshi(candles);
          const consec = countConsecutive(ha); // { color, count }
          
          const ema21 = computeEma(closes, 21);
          const ema9 = computeEma(closes, 9);
          const lastPriceForEma = spotPrice ?? lastPrice;
          const emaTrend = ema21 !== null ? (lastPriceForEma > ema21 ? "RISING" : "FALLING") : "NEUTRAL";
          
          const volumeRecent = candles.slice(-20).reduce((a, c) => a + c.volume, 0);
          const volumeAvg = candles.slice(-120).reduce((a, c) => a + c.volume, 0) / 6;
          
          const failedVwapReclaim = vwapNow !== null && vwapSeries.length >= 3
            ? closes[closes.length - 1] < vwapNow && closes[closes.length - 2] > vwapSeries[vwapSeries.length - 2]
            : false;

          const lastCandle = klines1m.length ? klines1m[klines1m.length - 1] : null;
          const lastClose = lastCandle?.close ?? null;
          const close1mAgo = klines1m.length >= 2 ? klines1m[klines1m.length - 2]?.close ?? null : null;
          const delta1m = lastClose !== null && close1mAgo !== null ? lastClose - close1mAgo : null;

          const regimeInfo = detectRegime({
            price: lastPrice,
            vwap: vwapNow,
            vwapSlope,
            vwapCrossCount,
            volumeRecent,
            volumeAvg
          });

          const scored = scoreDirection({
            price: lastPrice,
            vwap: vwapNow,
            vwapSlope,
            vwapCrossCount: null,
            volumeRecent: null,
            volumeAvg: null,
            rsi: rsiNow,
            rsiSlope,
            macd,
            heikenColor: consec.color,
            heikenCount: consec.count,
            failedVwapReclaim,
            delta: delta1m,
            gap: binanceGap, // Use internal Binance Gap for probability scoring
            priceToBeat
          });
          
          const timeAware = { timeDecay: 1, adjustedUp: scored.rawUp, adjustedDown: 1 - scored.rawUp };
          const marketUp = poly.ok ? poly.prices.up : null;
          const marketDown = poly.ok ? poly.prices.down : null;
          
          const settlementMs = poly.ok && poly.market?.endDate ? new Date(poly.market.endDate).getTime() : null;
          const settlementLeftMin = settlementMs ? (settlementMs - Date.now()) / 60_000 : null;
          const timeLeftMin = settlementLeftMin ?? timing.remainingMinutes;

          // Decide Signal
          const rec = decide({
            trend: emaTrend,
            timeLeftMin,
            spotPrice: currentPrice,
            strikePrice: priceToBeat,
            marketOdds: { up: marketUp, down: marketDown },
            indicators: {
                ema21,
                ema9,
                rsi: rsiNow,
                macd,
                heikinAshi: consec,
                vwap: vwapNow,
                candles
            }
          });

          const edge = computeEdge({
            modelUp: timeAware.adjustedUp,
            modelDown: timeAware.adjustedDown,
            marketYes: marketUp,
            marketNo: marketDown
          });

          rec.isExpired = (timeLeftMin !== null && timeLeftMin <= 0);
          rec.timeLeftMin = timeLeftMin;
          rec.strikePrice = priceToBeat;
          rec.spotPrice = currentPrice;
          rec.endDate = settlementMs;
          rec.probability = (rec.side === "UP") ? timeAware.adjustedUp : (rec.side === "DOWN" ? timeAware.adjustedDown : 0);
          if (!Number.isFinite(rec.probability)) rec.probability = 0.5;
          rec.edge = rec.side === "UP" ? edge.edgeUp : (rec.side === "DOWN" ? edge.edgeDown : 0);
          if (rec.edge < 0) rec.edge = 0;

          // Update Paper Trader
          await paper.update({
              signal: scored,
              rec,
              prices: poly.ok ? poly.prices : { up: null, down: null },
              market: poly.ok ? poly.market : null,
              tokens: poly.ok ? poly.tokens : null,
              trend: emaTrend, 
              timeLeftMin
          });
          
          // Log to DB
          // edge is already calculated above
          logSignalToDb({
            entry_minute: timing.elapsedMinutes,
            time_left_min: timeLeftMin,
            regime: regimeInfo.regime,
            signal: rec.action === "ENTER" ? (rec.side === "UP" ? "BUY UP" : "BUY DOWN") : "NO TRADE",
            model_up: timeAware.adjustedUp,
            model_down: timeAware.adjustedDown,
            mkt_up: marketUp,
            mkt_down: marketDown,
            edge_up: edge.edgeUp,
            edge_down: edge.edgeDown,
            recommendation: rec.action === "ENTER" ? `${rec.side}:${rec.strategy}:${rec.confidence}` : "NO_TRADE",
            price_to_beat: priceToBeat,
            current_price: currentPrice, // Use Chainlink for record
            binance_price: spotPrice,
            gap: uiGap // Log the UI Gap (Chainlink - Strike)
          }).catch(err => {
              // Non-blocking log failure
              if (err.message && err.message.includes("SQLITE_CANTOPEN")) {
                  pushActivity(`${ANSI.yellow}WARN: DB Busy, log skipped.${ANSI.reset}`);
              } else {
                  console.error("Failed to log signal:", err.message);
              }
          });
          
          // Store heavy computation results in a persistent object for Fast Ticks to read?
          global.lastAnalysis = {
             timeLeftMin,
             rec,
             marketUp,
             marketDown,
             totalEquity: paper.state.balance + paper.getUnrealizedPnL(poly.ok ? poly.prices : { up: null, down: null }),
             dailyPnl: -(paper.state.dailyLoss || 0),
             paperBalance: paper.state.balance,
             posPnl: paper.getUnrealizedPnL(poly.ok ? poly.prices : { up: null, down: null }),
             position: paper.state.positions && paper.state.positions.length > 0 ? paper.state.positions[0] : null,
             heikenValue: `${consec.color ?? "-"} x${consec.count}`,
             haNarrative: (consec.color ?? "").toLowerCase() === "green" ? "LONG" : (consec.color ?? "").toLowerCase() === "red" ? "SHORT" : "NEUTRAL",
             rsiValue: `${formatNumber(rsiNow, 1)}`,
             rsiNarrative: narrativeFromSlope(rsiSlope),
             macdLabel: macd?.hist < 0 ? "bearish" : "bullish",
             macdNarrative: narrativeFromSign(macd?.hist),
             vwapValue: formatNumber(vwapNow, 2),
             vwapNarrative: narrativeFromSign((lastPrice - vwapNow) / vwapNow),
             emaLabel: ema21 !== null ? `${formatNumber(ema21, 0)}` : "-",
             emaTrend,
             adviceLine: rec.action === "ENTER"
                ? (rec.side === "UP" ? "Bullish edge detected." : "Bearish edge detected.") 
                : (timeLeftMin !== null && timeLeftMin < 2 ? "LATE STAGE: Volatility high." : "Analyzing market momentum."),
             recentTrades: recentTrades,
             winStats: winStats
          };
      } // End Slow Tick

      // Calculate realtime PnL for UI (don't wait for slow tick) ...

      // --- BROADCAST (Every Tick 250ms) ---
      const analysis = global.lastAnalysis || {}; // Fallback if not yet run
      
      // Calculate realtime PnL for UI (don't wait for slow tick)
      const rtPrices = poly.ok ? poly.prices : { up: null, down: null };
      const rtPnl = paper.getUnrealizedPnL(rtPrices);
      const rtEquity = paper.state.balance + (paper.state.position ? rtPnl : 0);

      broadcast({
        type: "state",
        payload: {
          marketName: "Polymarket Active", 
          marketSlug: priceToBeatState.slug || "loading...", 
          timeLeftStr: fmtTimeLeft(analysis.timeLeftMin ?? timing.remainingMinutes),
          timeLeftMin: analysis.timeLeftMin ?? timing.remainingMinutes,
          etTime: fmtEtTime(new Date()),
          
          side: analysis.rec?.side || "NEUTRAL",
          phase: analysis.rec?.phase || "-",
          conviction: analysis.rec?.probability || 0,
          advice: analysis.adviceLine || "Initializing...",
          
          binancePrice: spotPrice,
          currentPrice: currentPrice,
          strikePrice: priceToBeat,
          gap: uiGap, 
          
          polyUp: analysis.marketUp ?? null,
          polyDown: analysis.marketDown ?? null,
          
          // USE REALTIME VALUES
          totalEquity: rtEquity,
          dailyPnl: -(paper.state.dailyLoss || 0),
          paperBalance: paper.state.balance,
          
          position: paper.state.positions && paper.state.positions.length > 0 ? paper.state.positions[0] : null,
          posPnl: rtPnl,
          
          // Indicators (Slow update is fine)
          indHeiken: { val: analysis.heikenValue, sentiment: analysis.haNarrative },
          indRsi: { val: analysis.rsiValue, sentiment: analysis.rsiNarrative },
          indMacd: { val: analysis.macdLabel, sentiment: analysis.macdNarrative },
          indVwap: { val: analysis.vwapValue, sentiment: analysis.vwapNarrative },
          indEma: { val: analysis.emaLabel, sentiment: analysis.emaTrend === "RISING" ? "LONG" : analysis.emaTrend === "FALLING" ? "SHORT" : "NEUTRAL" },
          
          recentTrades: recentTrades,
          winStats: analysis.winStats ? {
            today: { 
              wins: analysis.winStats.winsToday || 0, 
              total: analysis.winStats.totalToday || 0, 
              rate: (analysis.winStats.winsToday / analysis.winStats.totalToday) * 100 || 0 
            },
            overall: { 
              wins: analysis.winStats.winsAll || 0, 
              total: analysis.winStats.totalAll || 0, 
              rate: (analysis.winStats.winsAll / analysis.winStats.totalAll) * 100 || 0 
            }
          } : {
            today: { wins: 0, total: 0, rate: 0 },
            overall: { wins: 0, total: 0, rate: 0 }
          }
        }
      });

      // --- TERMINAL RENDERING ---
      if (process.stdout.isTTY) {
          const W = screenWidth();
          let out = "";
          out += `${sepLine("═")}\n`;
          out += `${centerText(`${ANSI.green}POLYBOT DASHBOARD${ANSI.reset} | ${fmtEtTime()} ET`, W)}\n`;
          out += `${sepLine("═")}\n\n`;

          out += `${section("MARKET STATUS")}\n`;
          out += `${kv("Market", (priceToBeatState.slug || "Loading...").slice(0, 30))}\n`;
          out += `${kv("Time Left", fmtTimeLeft(analysis.timeLeftMin ?? timing.remainingMinutes))}\n`;
          out += `${kv("Session", getBtcSession())}\n\n`;

          out += `${section("PRICES")}\n`;
          out += `${colorPriceLine({ label: "Binance Spot", price: spotPrice, prevPrice: prevSpotPrice, decimals: 0, prefix: "$" })}\n`;
          out += `${colorPriceLine({ label: "Current (CL)", price: currentPrice, prevPrice: prevCurrentPrice, decimals: 2, prefix: "$" })}\n`;
          out += `${kv("Strike Price", priceToBeat !== null ? `$${formatNumber(priceToBeat, 2)}` : "-")}\n`;
          
          if (uiGap !== null) {
              const gapColor = uiGap > 0 ? ANSI.green : uiGap < 0 ? ANSI.red : ANSI.gray;
              out += `${kv("Gap to Beat", `${gapColor}${uiGap > 0 ? "+" : ""}${uiGap.toFixed(2)}${ANSI.reset}`)}\n`;
          }
          out += "\n";

          out += `${section("INDICATORS")}\n`;
          out += `${kv("Heikin Ashi", colorByNarrative(analysis.heikenValue || "-", analysis.haNarrative))}\n`;
          out += `${kv("RSI (14m)", colorByNarrative(analysis.rsiValue || "-", analysis.rsiNarrative))}\n`;
          out += `${kv("MACD", colorByNarrative(analysis.macdLabel || "-", analysis.macdNarrative))}\n`;
          out += `${kv("VWAP", colorByNarrative(analysis.vwapValue || "-", analysis.vwapNarrative))}\n`;
          out += `${kv("EMA 21", colorByNarrative(analysis.emaLabel || "-", analysis.emaTrend === "RISING" ? "LONG" : "SHORT"))}\n\n`;

          out += `${section("POSITION / PNL")}\n`;
          if (paper.state.positions && paper.state.positions.length > 0) {
              const pos = paper.state.positions[0];
              const pnlColor = rtPnl >= 0 ? ANSI.green : ANSI.red;
              out += `${kv("Active Pos", `${pos.side} @ ${pos.entryPrice.toFixed(2)}`)}\n`;
              out += `${kv("Unrealized", `${pnlColor}${rtPnl >= 0 ? "+" : "-"}$${Math.abs(rtPnl).toFixed(2)}${ANSI.reset}`)}\n`;
          } else {
              out += `${kv("Active Pos", "NONE")}\n`;
          }
          out += `${kv("Account Bal", `$${paper.state.balance.toFixed(2)}`)}\n`;
          const dPnl = -(paper.state.dailyLoss || 0);
          const dPnlColor = dPnl >= 0 ? ANSI.green : ANSI.red;
          out += `${kv("Daily P&L", `${dPnlColor}${dPnl >= 0 ? "+" : "-"}$${Math.abs(dPnl).toFixed(2)}${ANSI.reset}`)}\n`;
          
          if (analysis.winStats) {
              const tw = analysis.winStats.winsToday;
              const tt = analysis.winStats.totalToday;
              const tr = tt > 0 ? (tw / tt) * 100 : 0;
              out += `${kv("Win Rate", `${tr.toFixed(0)}% (${tw}/${tt})`)}\n`;
          }
          out += "\n";

          out += `${section("RECENT ACTIVITY")}\n`;
          const logs = activityLog.slice(-5);
          for (const log of logs) {
              out += `${log}\n`;
          }

          renderScreen(out);
      }

      prevSpotPrice = spotPrice ?? prevSpotPrice;
      prevCurrentPrice = currentPrice ?? prevCurrentPrice;
      consecutiveErrors = 0;

      } catch (err) {
      if (err.message && (err.message.includes("fetch failed") || err.message.includes("network") || err.message.includes("ETIMEDOUT") || err.message.includes("ECONNRESET") || err.message.includes("aborted"))) {
          // Warning only
          pushActivity(`${ANSI.yellow}WARN: Network glitch (${err.message}). Retrying...${ANSI.reset}`);
      } else if (err.message && err.message.includes("SQLITE_CANTOPEN")) {
          // Warning only for database busy errors
          pushActivity(`${ANSI.yellow}WARN: Database busy. Retrying...${ANSI.reset}`);
      } else {
          // Critical
          consecutiveErrors++;
          pushActivity(`${ANSI.red}ERROR:${ANSI.reset} ${err?.message ?? String(err)} (${consecutiveErrors}/10)`);
          
          if (consecutiveErrors >= 10) {
              pushActivity(`${ANSI.red}CRITICAL: Too many consecutive errors. Exiting...${ANSI.reset}`);
              process.exit(1);
          }
      }
    }

    tickCount++;
    await sleep(LOOP_INTERVAL_MS);

    if (global.gc && tickCount % 240 === 0) {
       try { global.gc(); } catch (e) {}
    }
  }
}

const restoreCursor = () => {
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[?25h"); // Show cursor
  }
};

process.on("SIGINT", () => {
  restoreCursor();
  process.exit();
});

process.on("SIGTERM", () => {
  restoreCursor();
  process.exit();
});

process.on("exit", () => {
  restoreCursor();
});

main();
