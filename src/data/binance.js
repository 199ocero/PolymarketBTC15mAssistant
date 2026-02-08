import { CONFIG } from "../config.js";
import { fetchWithTimeout } from "../utils.js";

function toNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

export async function fetchKlines({ interval, limit }) {
  const url = new URL("/api/v3/klines", CONFIG.binanceBaseUrl);
  url.searchParams.set("symbol", CONFIG.symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", String(limit));

  const res = await fetchWithTimeout(url, { timeout: 4000 });
  if (!res.ok) {
    throw new Error(`Binance klines error: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();

  return data.map((k) => ({
    openTime: Number(k[0]),
    open: toNumber(k[1]),
    high: toNumber(k[2]),
    low: toNumber(k[3]),
    close: toNumber(k[4]),
    volume: toNumber(k[5]),
    closeTime: Number(k[6])
  }));
}

export async function fetchLastPrice() {
  const url = new URL("/api/v3/ticker/price", CONFIG.binanceBaseUrl);
  url.searchParams.set("symbol", CONFIG.symbol);
  const res = await fetchWithTimeout(url, { timeout: 3000 });
  if (!res.ok) {
    throw new Error(`Binance last price error: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return toNumber(data.price);
}
