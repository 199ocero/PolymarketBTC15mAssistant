# PolyBot: Polymarket BTC 15m Assistant

A robust, real-time trading assistant and paper trading engine for Polymarket **"Bitcoin Up or Down" 15-minute** markets. 

PolyBot combines advanced technical analysis with real-time data feeds to provide high-conviction trade signals via a sleek web dashboard.

## Key Features

- **Web Dashboard**: Real-time monitoring of signals, prices, and account status without terminal clutter.
- **Advanced TA Engine**: Integrated Heiken Ashi, RSI, MACD, VWAP, and EMA analysis.
- **Paper Trading**: Realistic simulation engine for testing strategies with configurable risk management (Max consecutive losses, daily loss limits).
- **Multi-Source Data**: Combines Polymarket Live WS (Chainlink feed), Binance Spot Price, and on-chain Chainlink fallbacks.
- **Background Execution**: Managed via PM2 for 24/7 reliability and auto-recovery.
- **Configurable**: Easily adjust ports, risk parameters, and RPC settings via `.env`.

## Requirements

- **Node.js 18+**
- **npm**
- **PM2** (Recommended for background execution: `npm install -g pm2`)

## Installation & Setup

1. **Clone & Install**:
   ```bash
   git clone <repository-url>
   cd polybot
   npm install
   ```

2. **Configuration**:
   Copy `.env.example` to `.env` (if provided) or configure the following in your `.env`:
   ```env
   PORT=4000
   PAPER_BALANCE=1000
   POLYGON_RPC_URL="https://polygon-rpc.com"
   ```

3. **Database Setup**:
   The bot uses SQLite for logging. It will be initialized automatically on the first run.

## Running the Bot

### Background (Recommended)
Use PM2 to run the bot in the background. It will automatically restart on crashes or system reboots.
```bash
pm2 start ecosystem.config.cjs
```

- **Monitor**: `pm2 monit`
- **Logs**: `pm2 logs polybot`
- **Stop**: `pm2 stop polybot`
- **Restart**: `pm2 restart polybot`

### Development / Legacy
If you want to run it manually and see logs (CLI rendering is disabled to focus on the UI):
```bash
npm start
```

## Dashboard Access
Once running, access the dashboard at:
`http://localhost:4000` (or whatever `PORT` you configured).

## Safety & Disclaimer
This is a trading assistant for informational and paper-trading purposes. It is **not financial advice**. Use at your own risk.

---
**Created by**: @krajekis  
**Modified by**: jaocero
