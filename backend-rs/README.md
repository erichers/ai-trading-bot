# AI Trading Terminal Backend — Rust (axum) port

A Rust/axum port of the Python FastAPI trading backend. It serves the **identical
`/api` contract and JSON shapes** so the existing React frontend works unchanged.

- **Port:** `8001` (the Python app uses `8000`)
- **Data:** REAL only — Alpaca + real LLMs (Kimi / Ollama-Gemma). No mock data.
  On upstream failure it returns a clear HTTP error (`503` upstream / `424` missing
  credentials) with a `{"detail": "..."}` body, never fabricated data.
- **Database:** the SAME MySQL `trading_terminal` DB and tables as the Python app
  (read/write via `sqlx`). No destructive migrations.

## Run

```bash
cd backend-rs
~/.cargo/bin/cargo run        # builds + serves on http://localhost:8001
```

Config is read from the repo-root `../.env` (Alpaca keys, Kimi, Ollama, MySQL).
Requires: MySQL (MAMP) on `127.0.0.1:8889`, and Ollama on `:11434` for research/chat.

Quick smoke test:

```bash
curl localhost:8001/api/health
curl localhost:8001/api/account
curl "localhost:8001/api/bars/AAPL?timeframe=1Day&limit=5"
```

## What's implemented (all under `/api`)

**Tier 1 — market + account (Alpaca REST/data, real):**
`GET /health`, `/account`, `/positions`, `/orders`, `/clock`, `/calendar`,
`/assets`, `/bars/{symbol}`, `/quote/{symbol}`, `/snapshot/{symbol}`, `/snapshots`,
`/news`, `/watchlist` (+POST/DELETE), `/indicators/{symbol}` (+`/catalog`).
Indicators (SMA/EMA/RSI/MACD/Bollinger/ATR/VWAP/ADX/Stoch/OBV/volume) are computed
in pure Rust from real bars.

**Tier 2 — trading + risk + options + strategies + bots:**
`POST/DELETE /orders` (incl. bracket + kill switch), `GET /trades`,
`GET/PUT /risk/limits`, `GET /risk/status`, `POST /risk/check|size|kill-switch`,
`GET /risk/events`, options `expirations|chain|flow|select`, strategies CRUD +
`signals/evaluate|history`, bots CRUD + `bots/{id}/evaluate|run`.
The deterministic risk engine is a faithful port (vetoes/warnings/computed).

**Tier 3 — research + chat + worker + websocket:**
`POST /research/analyze` (Kimi primary → Gemma backup), `/research/feed|deep|
worker|briefing|regime`, a background research worker (tokio task, Gemma, interval),
`POST /chat` + `/chat/schema|history` (Vanna: Gemma writes a read-only SELECT,
validated SELECT-only + LIMIT, executed via sqlx), and `GET /ws` streaming real
Alpaca watchlist snapshots (~2s).

## Architecture

| Module | Responsibility |
|---|---|
| `config.rs` | Load settings from `../.env` |
| `alpaca.rs` | Alpaca trading + market-data REST via reqwest (APCA headers, IEX feed) |
| `indicators.rs` | Pure-Rust technical indicators |
| `db.rs` | MySQL persistence via sqlx (shared tables) |
| `risk.rs` | Deterministic risk engine |
| `options.rs` | Real options expirations/chain/flow/select |
| `research.rs` | Kimi/Gemma research, briefings, regime, deep dives |
| `chat.rs` | Vanna-style text-to-SQL chat |
| `bots.rs` | Weekly-options bot engine |
| `signals.rs` | Indicator-rule evaluation |
| `worker.rs` | Background research worker + websocket broadcaster |
| `llm.rs` | Kimi (OpenAI-compatible) + Ollama clients |
| `main.rs` | axum router, handlers, CORS, startup |

CORS allows `http://localhost:5173`, `:3000`, `:8888`.
