import WebSocket from "ws";
import { CONFIG } from "../src/data/../config.js";
import { wsAgentForUrl } from "../src/net/proxy.js";
import dotenv from "dotenv";
dotenv.config();

const symbol = "btcusdt";
const url = `wss://stream.binance.vision/ws/${symbol}@trade`;

console.log(`[Debug] Testing Binance WebSocket...`);
console.log(`[Debug] URL: ${url}`);

const agent = wsAgentForUrl(url);
if (agent) {
  console.log(`[Debug] Using proxy agent.`);
} else {
  console.log(`[Debug] No proxy agent configured.`);
}

const ws = new WebSocket(url, { 
  agent,
  rejectUnauthorized: false
});

ws.on("open", () => {
  console.log(`[Debug] WebSocket connected! Waiting for messages...`);
});

ws.on("message", (data) => {
  console.log(`[Debug] Message received: ${data.toString()}`);
  // Exit after one message to confirm it works
  process.exit(0);
});

ws.on("error", (err) => {
  console.error(`[Debug] WebSocket error:`, err);
  process.exit(1);
});

ws.on("close", (code, reason) => {
  console.log(`[Debug] WebSocket closed. Code: ${code}, Reason: ${reason}`);
});

// Timeout after 10 seconds
setTimeout(() => {
  console.log("[Debug] Timeout: No message received after 10 seconds.");
  process.exit(1);
}, 10000);
