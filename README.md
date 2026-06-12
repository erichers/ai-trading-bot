# AI Trading Bot

An AI-assisted, **paper-first** algorithmic trading platform: a deterministic strategy + risk engine, a Claude-powered market analyst for news/sentiment/regime interpretation, and a React dashboard for steering it all. Built on [Alpaca](https://alpaca.markets) for commission-free US equities/ETFs/options/crypto.

> ⚠️ **Educational project — not investment advice.** Automated trading can lose money rapidly. Backtest and paper results do not guarantee live performance. Trade live only with capital you can afford to lose.

---

## Core principle

**The LLM proposes; deterministic code disposes.**

Claude generates trade theses and signals, but a rule-based **risk engine validates every order** against hard-coded limits before anything touches the broker. LLMs add value in *information processing* (news, earnings, sentiment, regime) — not millisecond execution. This system targets swing/intraday horizons (minutes to hours), never HFT, and ships paper-first.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     WEB DASHBOARD (React)                      │
│   Steering Console │ Charts │ Positions │ AI Research Feed     │
└─────────────▲──────────────────────────────▲─────────────────┘
              │ REST (FastAPI)               │ WebSocket (live push)
┌─────────────┴──────────────────────────────┴─────────────────┐
│                       BACKEND (Python)                        │
│   Strategy Engine ─▶ AI Analyst (Claude) ─▶ Risk Engine ─▶    │
│   Execution Manager   │  Market Data Service │ News Service    │
│   PostgreSQL + TimescaleDB · Redis                            │
└──────────────────────────────────┼───────────────────────────┘
                                    ▼
                   ┌────────────────────────────────┐
                   │ ALPACA API (paper → live)       │
                   │ Trading + Data + News WebSocket │
                   └────────────────────────────────┘
```

### Components

| Component | Responsibility |
|---|---|
| **Market Data Service** | Holds the Alpaca WebSocket, subscribes to bars/quotes/trades, computes rolling indicators, persists bars to TimescaleDB, republishes to the frontend. Auto-reconnect with backoff + REST gap-fill. |
| **Strategy Engine** | Evaluates composable trigger rules each bar close (1m/5m/15m/1h/1d) over an indicator library (SMA/EMA, RSI, MACD, Bollinger, ATR, VWAP, Stochastic, ADX, OBV). Emits a **signal, not an order**. |
| **AI Analyst (Claude)** | On signals/schedule/demand: bars + indicators + Alpaca news → structured JSON `{thesis, sentiment, conviction, key_risks, suggested_action/stop/target, regime}`, plus a bull/bear critique pass. Every analysis is stored and auditable. |
| **Risk Engine** | Pure deterministic veto layer: max position size, max open positions, daily-loss circuit breaker, per-trade risk (R), concentration limits, time windows, PDT awareness, kill switch. Sizing: `qty = (equity × risk%) / (entry − stop)`. |
| **Execution Manager** | Default **bracket orders** (entry + take-profit + stop-loss, atomic). Trailing-stop exits via the `trade_updates` fill-listener workaround. Handles partial fills, rejections, breakeven moves, EOD flatten. |

### Trading modes

- **Signal-only** — alerts, no orders.
- **Semi-auto** — AI proposes, you approve each trade with one tap.
- **Full-auto** — the risk engine is the only gate.

Paper/live is a global, prominently displayed switch. Live mode requires re-authentication and shows a persistent red banner.

---

## Tech stack

- **Backend:** Python 3.12, FastAPI, `alpaca-py`, asyncio
- **Database:** PostgreSQL + TimescaleDB · **Cache/pubsub:** Redis
- **AI:** Anthropic API (Sonnet for routine scans, Opus-class for deep research)
- **Frontend:** React + TypeScript + Vite, Tailwind, shadcn/ui
- **Charts:** TradingView Lightweight Charts
- **Backtesting:** vectorbt / backtrader on Alpaca historical bars
- **Deploy:** Docker Compose → VPS / Fly.io / Railway

---

## Getting started

### Prerequisites
- Python 3.12+, Node 20+, Docker
- A free [Alpaca paper trading account](https://app.alpaca.markets) and API keys
- An [Anthropic API key](https://console.anthropic.com)

### Setup

```bash
git clone https://github.com/erichers/<repo>.git
cd <repo>

# Configure secrets (never commit these)
cp .env.example .env
# edit .env with your Alpaca paper keys + Anthropic key

# Bring up Postgres/Timescale + Redis
docker compose up -d   # (added in Phase 0)
```

The Alpaca paper endpoint is `https://paper-api.alpaca.markets/v2`. Use the `FAKEPACA` test symbol to validate the data pipeline before market hours.

### Optional: Alpaca MCP server

The official [Alpaca MCP server](https://github.com/alpacahq/alpaca-mcp-server) exposes 65 trading/market-data tools to Claude Code. It **defaults to paper** and only goes live when `ALPACA_PAPER_TRADE=false` is set with live keys.

---

## Roadmap

- [x] **Phase 0 — Setup:** paper account, repo scaffold, Docker (Postgres/Timescale + Redis), stream `FAKEPACA` to a chart.
- [ ] **Phase 1 — Data & charts:** historical ingest, indicator service, watchlist, chart overlays, WS fanout.
- [ ] **Phase 2 — Strategy engine + manual trading:** JSON rule schema + evaluator, signals, bracket-order ticket, positions/orders views.
- [ ] **Phase 3 — Risk engine + automation:** limits, circuit breakers, kill switch, sizing, trailing-stop-on-fill, full-auto (paper).
- [ ] **Phase 4 — AI analyst:** Claude structured outputs, news ingest, morning briefing, deep-dive, bull/bear pass, NL→rule translation.
- [ ] **Phase 5 — Backtesting + hardening:** backtest module, walk-forward, chaos testing, audit export, alerting.
- [ ] **Phase 6 — Live gate:** ≥30 paper trading days with positive expectancy → live at 1–5% size, semi-auto, scale gradually.

---

## Security

- **Secrets are server-side only**, in a gitignored `.env` (see `.env.example`). They are never committed and never pasted into any AI chat context.
- Keep **live** keys out of MCP/AI tool contexts; the system stays in paper mode (`ALPACA_PAPER_TRADE=true`) until the live gate.
- Every order is audit-logged with its originating signal and AI analysis.

## Disclaimer

This software is provided for educational purposes only and does not constitute financial, investment, or trading advice. Stops and conditional orders are best-effort and can fail near market close or during outages. You are solely responsible for any trading decisions and losses. Use at your own risk.

## License

MIT
