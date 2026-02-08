import fs from "node:fs";
import path from "node:path";

export function clamp(x, min, max) {
  return Math.max(min, Math.min(max, x));
}

export async function fetchWithTimeout(resource, options = {}) {
  const { timeout = 5000 } = options;
  
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(resource, {
      ...options,
      signal: controller.signal
    });
    return response;
  } finally {
    clearTimeout(id);
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatNumber(x, digits = 0) {
  if (x === null || x === undefined || Number.isNaN(x)) return "-";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(x);
}

export function formatPct(x, digits = 2) {
  if (x === null || x === undefined || Number.isNaN(x)) return "-";
  return `${(x * 100).toFixed(digits)}%`;
}

export function getCandleWindowTiming(windowMinutes) {
  const nowMs = Date.now();
  const windowMs = windowMinutes * 60_000;
  const startMs = Math.floor(nowMs / windowMs) * windowMs;
  const endMs = startMs + windowMs;
  const elapsedMs = nowMs - startMs;
  const remainingMs = endMs - nowMs;
  return {
    startMs,
    endMs,
    elapsedMs,
    remainingMs,
    elapsedMinutes: elapsedMs / 60_000,
    remainingMinutes: remainingMs / 60_000
  };
}

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

const streamCache = new Map();

function getLogStream(filePath) {
  if (streamCache.has(filePath)) return streamCache.get(filePath);

  ensureDir(path.dirname(filePath));
  const stream = fs.createWriteStream(filePath, { flags: "a", encoding: "utf8" });
  
  stream.on("error", (err) => {
    console.error(`Stream error for ${filePath}:`, err);
    streamCache.delete(filePath); // Invalidate on error to retry next time
  });

  streamCache.set(filePath, stream);
  return stream;
}

export function appendCsvRow(filePath, header, row) {
  try {
    const exists = fs.existsSync(filePath);
    
    const line = row
      .map((v) => {
        if (v === null || v === undefined) return "";
        const s = String(v);
        if (s.includes(",") || s.includes("\n") || s.includes('"')) {
          return `"${s.replaceAll('"', '""')}"`;
        }
        return s;
      })
      .join(",");

    const stream = getLogStream(filePath);
    
    // If file didn't exist (or was deleted), we might need to write header.
    // However, with persistent stream, checking existsSync might be flaky if stream created the file.
    // A simple heuristic: if we just created the stream, we might check stats?
    // Actually, simple approach: check size? 
    // fs.existsSync is cheap-ish.
    
    // Better: if file is empty, write header.
    // We can use fs.statSync to check size 0, but handle error if not exists.
    let isNew = !exists;
    try {
        const stats = fs.statSync(filePath);
        if (stats.size === 0) isNew = true;
    } catch {
        isNew = true;
    }

    if (isNew) {
      stream.write(`${header.join(",")}\n`);
    }

    stream.write(`${line}\n`);
    
  } catch (err) {
    console.error(`Failed to write to ${filePath}:`, err.message);
  }
}

