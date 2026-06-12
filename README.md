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
| **AI Analyst (local Gemma)** | On signals/schedule/demand: bars + indicators + Alpaca news → structured JSON `{thesis, sentiment, conviction, key_risks, suggested_action/stop/target, regime, bear_case}` from `gemma4:e2b` via Ollama (no cloud key). Every analysis is persisted to MySQL and auditable. |
| **Risk Engine** | Pure deterministic veto layer: max position size, max open positions, daily-loss circuit breaker, per-trade risk (R), concentration limits, time windows, PDT awareness, kill switch. Sizing: `qty = (equity × risk%) / (entry − stop)`. |
| **Execution Manager** | Default **bracket orders** (entry + take-profit + stop-loss, atomic). Trailing-stop exits via the `trade_updates` fill-listener workaround. Handles partial fills, rejections, breakeven moves, EOD flatten. |

### Trading modes

- **Signal-only** — alerts, no orders.
- **Semi-auto** — AI proposes, you approve each trade with one tap.
- **Full-auto** — the risk engine is the only gate.

Paper/live is a global, prominently displayed switch. Live mode requires re-authentication and shows a persistent red banner.

---

## Tech stack

- **Backend:** Python 3.12, FastAPI, `alpaca-py`, SQLAlchemy 2.0, asyncio
- **Database:** MySQL 8 (via MAMP) — trades ledger, research, signals, config
- **AI:** local **Gemma (`gemma4:e2b`) via Ollama** by default; Anthropic API optional
- **Frontend:** React + TypeScript + Vite, Tailwind, shadcn/ui
- **Charts:** TradingView Lightweight Charts
- **Backtesting:** vectorbt / backtrader on Alpaca historical bars
- **Deploy:** Docker Compose → VPS / Fly.io / Railway

---

## The app

A full Bloomberg-style trading terminal lives in this repo:

- **`backend/`** — FastAPI + `alpaca-py` (live paper trading & market data), pure-pandas indicators, Anthropic-powered AI research, SQLite persistence, and a `/ws` realtime feed. ~30 endpoints under `/api`.
- **`frontend/`** — React + TypeScript + Vite + Tailwind dark terminal UI with 9 views: **Dashboard, Tickers, Options Flow (weekly/daily), Strategies (indicators-to-fire), Research, News, Positions & Orders, Settings, Help** — TradingView charts, live watchlist with tick flashes, function bar with command search + **KILL SWITCH**.

### Prerequisites
- Python 3.11+ (3.12 recommended), Node 20+
- A free [Alpaca paper trading account](https://app.alpaca.markets) and API keys
- *(Optional)* an [Anthropic API key](https://console.anthropic.com) — AI research serves structured mock data without one

### Local infrastructure

This deployment runs entirely on local infra — no cloud AI key required:

- **MySQL via MAMP** (`127.0.0.1:8889`, db `trading_terminal`) — persists **all trades**, research analyses, signals, briefings, strategies, watchlist. Start MAMP, or `/Applications/MAMP/bin/startMysql.sh`.
- **Local AI research via Ollama** — model **`gemma4:e2b`** at `localhost:11434`. `ollama serve && ollama pull gemma4:e2b`.
- **Alpaca** paper trading + market data + **real options chains** (entitlement enabled).

### Run it — two modes

**Dev (hot reload):**
```bash
cp .env.example .env        # add your Alpaca paper keys
./dev.sh                    # backend :8000 + Vite :5173 → http://localhost:5173
```

**Served under MAMP/Apache at `/sandbox/` (production-style):**
```bash
# one-time: append the Apache vhost block, then restart MAMP's Apache
cat deploy/apache-sandbox.conf >> /Applications/MAMP/conf/apache/httpd.conf

./serve.sh                  # builds the SPA + runs Ollama/MySQL/backend
# → open http://localhost:8888/sandbox/
```
Apache serves the built SPA from `frontend/dist` and reverse-proxies `/sandbox/api` and `/sandbox/ws` to the FastAPI backend on :8000 (same-origin, websockets via `mod_proxy_wstunnel`).

The app **defaults to paper mode** and degrades gracefully: every external call falls back to realistic mock data, so the UI never crashes when a feed or key is missing.

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
