import sqlite3 from "sqlite3";
import path from "node:path";
import { ensureDir } from "./utils.js";
import { CONFIG } from "./config.js";

// Ensure logs directory exists
const DB_PATH = path.resolve("./logs/trading_data.db");
ensureDir(path.dirname(DB_PATH));

// Initialize Database Connection
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error("Failed to connect to SQLite database:", err.message);
  } else {
    // console.log("Connected to SQLite trading database.");
    initializeTables();
  }
});

// Create tables if they don't exist
function initializeTables() {
  db.serialize(() => {
    // Signals Table
    db.run(`
      CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        entry_minute REAL,
        time_left_min REAL,
        regime TEXT,
        signal TEXT,
        model_up REAL,
        model_down REAL,
        mkt_up REAL,
        mkt_down REAL,
        edge_up REAL,
        edge_down REAL,
        recommendation TEXT,
        price_to_beat REAL,
        current_price REAL,
        binance_price REAL,
        gap REAL
      )
    `);

    // Paper Trades Table
    db.run(`
      CREATE TABLE IF NOT EXISTS paper_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        action TEXT,
        side TEXT,
        price REAL,
        amount REAL,
        shares REAL,
        pnl REAL,
        balance REAL,
        market_slug TEXT,
        fee REAL
      )
    `);
  });
}

// Helper to run insert
export function logSignalToDb(data) {
  return new Promise((resolve, reject) => {
    const query = `
      INSERT INTO signals (
        timestamp, entry_minute, time_left_min, regime, signal, 
        model_up, model_down, mkt_up, mkt_down, edge_up, edge_down, 
        recommendation, price_to_beat, current_price, binance_price, gap
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    const params = [
      new Date().toISOString(),
      data.entry_minute,
      data.time_left_min,
      data.regime,
      data.signal,
      data.model_up,
      data.model_down,
      data.mkt_up,
      data.mkt_down,
      data.edge_up,
      data.edge_down,
      data.recommendation,
      data.price_to_beat,
      data.current_price,
      data.binance_price,
      data.gap
    ];

    db.run(query, params, function(err) {
      if (err) {
        console.error("Error inserting signal log:", err.message);
        reject(err);
      } else {
        resolve(this.lastID);
      }
    });
  });
}

export function logPaperTradeToDb(data) {
  return new Promise((resolve, reject) => {
    const query = `
      INSERT INTO paper_trades (
        timestamp, action, side, price, amount, shares, pnl, balance, market_slug, fee
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const params = [
      new Date().toISOString(),
      data.action,
      data.side,
      data.price,
      data.amount,
      data.shares,
      data.pnl,
      data.balance,
      data.market_slug,
      data.fee
    ];

    db.run(query, params, function(err) {
      if (err) {
        console.error("Error inserting paper trade log:", err.message);
        reject(err);
      } else {
        resolve(this.lastID);
      }
    });
  });
}

export function getWinStats() {
  return new Promise((resolve, reject) => {
    // We want two aggregates:
    // 1. Overall: count(*) as total, sum(case when pnl > 0 then 1 else 0 end) as wins
    // 2. Today: same but where timestamp >= today_start
    
    // SQLite doesn't have complex date functions easily available without extensions sometimes, 
    // but ISO strings sort/compare well.
    
    const now = new Date();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();

    const query = `
      SELECT 
        COUNT(*) as total_all,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins_all,
        SUM(CASE WHEN timestamp >= ? THEN 1 ELSE 0 END) as total_today,
        SUM(CASE WHEN timestamp >= ? AND pnl > 0 THEN 1 ELSE 0 END) as wins_today
      FROM paper_trades
      WHERE pnl IS NOT NULL
    `;

    db.get(query, [todayStart, todayStart], (err, row) => {
      if (err) {
        console.error("Error fetching win stats:", err);
        resolve({ totalAll: 0, winsAll: 0, totalToday: 0, winsToday: 0 }); // Fail safe
      } else {
        resolve({
          totalAll: row?.total_all || 0,
          winsAll: row?.wins_all || 0,
          totalToday: row?.total_today || 0,
          winsToday: row?.wins_today || 0
        });
      }
    });
  });
}
