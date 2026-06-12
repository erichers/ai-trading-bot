# AI Trading Terminal — Backend

FastAPI backend for a Bloomberg-terminal-style AI trading app. Wraps Alpaca
(paper) for trading + market data and Anthropic Claude for AI research. **Every
external call falls back to realistic mock data on failure**, so the server runs
even with no credentials or no network.

## Requirements

- Python 3.11+ (3.12 recommended)
- Credentials read from the **repo-root `.env`** (one level up from `backend/`):
  - `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`
  - `ALPACA_API_BASE_URL` (paper: `https://paper-api.alpaca.markets/v2`)
  - `ALPACA_PAPER_TRADE=true`
  - `ANTHROPIC_API_KEY` (optional — absent ⇒ mock research)

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
- `GET /api/health`

### Account / trading
- `GET /api/account`
- `GET /api/positions`
- `GET /api/orders?status=open|closed|all`
- `POST /api/orders` (bracket order when `take_profit` + `stop_loss` present)
- `DELETE /api/orders/{id}`
- `DELETE /api/orders` — **kill switch** (cancel all)
- `GET /api/clock`
- `GET /api/calendar?start=&end=`

### Market data (IEX feed)
- `GET /api/assets?search=&limit=20`
- `GET /api/bars/{symbol}?timeframe=1Min|5Min|15Min|1Hour|1Day&limit=300`
- `GET /api/quote/{symbol}`
- `GET /api/snapshot/{symbol}`
- `GET /api/snapshots?symbols=AAPL,MSFT`

### News
- `GET /api/news?symbols=AAPL,TSLA&limit=30`

### Options
- `GET /api/options/expirations/{symbol}` (weekly vs monthly flagged)
- `GET /api/options/chain/{symbol}?expiration=YYYY-MM-DD&type=call|put|all`
- `GET /api/options/flow/{symbol}?period=weekly|daily` (surfaces unusual flow)

### Watchlist (SQLite, seeded AAPL/MSFT/NVDA/TSLA/SPY/QQQ)
- `GET /api/watchlist`
- `POST /api/watchlist` `{symbol}`
- `DELETE /api/watchlist/{symbol}`

### Indicators (pure pandas)
- `GET /api/indicators/{symbol}?timeframe=1Day`
- `GET /api/indicators/catalog`

### Strategies / signals (SQLite)
- `GET|POST /api/strategies`, `PUT|DELETE /api/strategies/{id}`
- `POST /api/signals/evaluate` `{symbol, timeframe, rules}`

### AI research (Anthropic `claude-sonnet-4-6`, mock fallback)
- `POST /api/research/analyze` `{symbol}`
- `GET /api/research/briefing`
- `GET /api/research/regime`

### Realtime
- `WebSocket /ws` — pushes `{type:'quote'|'news'|'signal', ...}` ~every 2s

## Live vs mocked

| Area | Live (with creds + network) | Mock fallback |
|------|------------------------------|---------------|
| Account, positions, orders, clock, calendar | Alpaca `TradingClient` (paper) | yes |
| Assets, bars, quote, snapshot(s) | Alpaca `StockHistoricalDataClient` (IEX) | yes |
| News | Alpaca `NewsClient` if available | yes |
| Options (expirations/chain/flow) | **Mocked** (realistic chains) — Alpaca options availability varies | n/a |
| Indicators | Computed in pandas from whatever bars are returned | from mock bars |
| AI research | Anthropic Claude (`claude-sonnet-4-6`) | structured mock JSON |
| Realtime WS | Polls Alpaca snapshots when market open | random-walk |

Persistence (watchlist, strategies) is SQLite at `backend/trading.db`.
