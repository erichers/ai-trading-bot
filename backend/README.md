# AI Trading Terminal — Backend

FastAPI backend for a Bloomberg-terminal-style AI trading app. Wraps Alpaca
(paper) for trading + market data + **real options data**, persists everything to
**MySQL**, and runs AI research **locally via Ollama (Gemma)**. **Every external
call falls back to realistic mock data on failure**, so the server runs even with
no credentials, no Ollama, or no network.

## Requirements

- Python 3.11+
- **MySQL 8** — MAMP defaults (host `127.0.0.1`, port `8889`, user `root`,
  password `root`, database `trading_terminal`). The database must exist; tables
  are auto-created on startup via SQLAlchemy `Base.metadata.create_all`.
- **Ollama** running locally with the `gemma4:e2b` model pulled
  (`ollama pull gemma4:e2b`), reachable at `http://localhost:11434`.
- Credentials/config read from the **repo-root `.env`** (one level up from `backend/`):
  - `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`
  - `ALPACA_API_BASE_URL` (paper: `https://paper-api.alpaca.markets/v2`)
  - `ALPACA_PAPER_TRADE=true`
  - `ALPACA_OPTIONS_FEED` — `indicative` (free, default) or `opra` (real-time)
  - `RESEARCH_PROVIDER=ollama` (or `anthropic`)
  - `OLLAMA_BASE_URL=http://localhost:11434`
  - `RESEARCH_MODEL=gemma4:e2b`
  - `ANTHROPIC_API_KEY` (optional — only used when `RESEARCH_PROVIDER=anthropic`)
  - `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_NAME`
  - `DATABASE_URL=mysql+pymysql://root:root@127.0.0.1:8889/trading_terminal`

### MySQL (MAMP) quick check

```bash
/Applications/MAMP/Library/bin/mysql80/bin/mysql -u root -proot -h 127.0.0.1 -P 8889 \
  trading_terminal -e "SHOW TABLES;"
```

### Ollama quick check

```bash
curl http://localhost:11434/api/tags          # lists models
ollama pull gemma4:e2b                         # if missing
```

## Run

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Server: <http://localhost:8000>  •  Interactive docs: <http://localhost:8000/docs>

CORS allows `http://localhost:5173` and `http://localhost:3000`. All REST routes
are under `/api`. WebSocket live feed is at `/ws`.

## Endpoints

### Health
- `GET /api/health` — includes `research_provider`, `research_model`,
  `ollama_connected`, `alpaca_connected`, `market_open`, `paper`.

### Account / trading
- `GET /api/account`
- `GET /api/positions`
- `GET /api/orders?status=open|closed|all` — also **reconciles** current Alpaca
  orders into the `trades` table (fills/cancels update existing rows).
- `POST /api/orders` — equity (bracket when `take_profit`+`stop_loss` present) and
  **options** (auto-detected from an OCC symbol or `asset_class:"option"`).
  Optional body fields: `source` (`manual`/`strategy`/`ai`), `strategy_id`. Every
  submit is persisted to `trades` with the raw Alpaca response.
- `DELETE /api/orders/{id}` — cancels and marks the trade row canceled.
- `DELETE /api/orders` — **kill switch** (cancel all)
- `GET /api/trades?status=&symbol=&limit=100` — persisted trades, newest first.
- `GET /api/clock`
- `GET /api/calendar?start=&end=`

### Market data (IEX feed)
- `GET /api/assets?search=&limit=20`
- `GET /api/bars/{symbol}?timeframe=1Min|5Min|15Min|1Hour|1Day&limit=300`
- `GET /api/quote/{symbol}` · `GET /api/snapshot/{symbol}` · `GET /api/snapshots?symbols=AAPL,MSFT`

### News
- `GET /api/news?symbols=AAPL,TSLA&limit=30`

### Options (REAL Alpaca data, mock fallback)
- `GET /api/options/expirations/{symbol}` — from `get_option_contracts`
  (paginated), distinct sorted dates, weekly vs monthly (3rd-Friday) flagged.
- `GET /api/options/chain/{symbol}?expiration=YYYY-MM-DD&type=call|put|all` — from
  `OptionHistoricalDataClient.get_option_chain`; real bid/ask/last/greeks/IV/OI,
  strike & type parsed from the OCC symbol.
- `GET /api/options/flow/{symbol}?period=weekly|daily` — aggregated from the real
  chain (call/put volume, put/call ratio, per-strike premium, unusual = volume > 2×OI).

### Watchlist (MySQL, seeded AAPL/MSFT/NVDA/TSLA/SPY/QQQ)
- `GET /api/watchlist` · `POST /api/watchlist {symbol}` · `DELETE /api/watchlist/{symbol}`

### Indicators (pure pandas)
- `GET /api/indicators/{symbol}?timeframe=1Day` · `GET /api/indicators/catalog`

### Strategies / signals (MySQL)
- `GET|POST /api/strategies`, `PUT|DELETE /api/strategies/{id}`
- `POST /api/signals/evaluate {symbol, timeframe, rules}` — persisted to `signals`.
- `GET /api/signals/history?symbol=&limit=50`

### AI research (Ollama `gemma4:e2b` by default, Anthropic optional, mock fallback)
- `POST /api/research/analyze {symbol}` — persisted to `research_analyses`.
- `GET /api/research/history?symbol=&limit=50`
- `GET /api/research/briefing` — persisted to `briefings`.
- `GET /api/research/regime`

### Realtime
- `WebSocket /ws` — pushes `{type:'quote'|'news'|'signal', ...}` ~every 2s

## Persistence (MySQL `trading_terminal`)

SQLAlchemy 2.0 ORM, JSON columns for nested data. Tables:
`watchlist`, `strategies`, `settings`, `trades`, `research_analyses`,
`signals`, `briefings`.

## Live vs mocked

| Area | Live (with creds + network) | Mock fallback |
|------|------------------------------|---------------|
| Account, positions, orders, clock, calendar | Alpaca `TradingClient` (paper) | yes |
| Assets, bars, quote, snapshot(s) | Alpaca `StockHistoricalDataClient` (IEX) | yes |
| News | Alpaca `NewsClient` if available | yes |
| Options (expirations/chain/flow) | **Alpaca `get_option_contracts` + `get_option_chain`** (feed = `ALPACA_OPTIONS_FEED`) | yes — on empty/unentitled |
| Option orders | Alpaca single-leg market/limit/stop (whole qty, tif day/gtc, no bracket) | mock ack |
| Indicators | Computed in pandas from returned bars | from mock bars |
| AI research | **Ollama / Gemma** (`/api/chat`, `format:"json"`); Anthropic if configured | structured mock JSON |
| Realtime WS | Polls Alpaca snapshots when market open | random-walk |
