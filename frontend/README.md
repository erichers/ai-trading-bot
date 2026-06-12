# TERMINAL — AI Trading Frontend

A Bloomberg-terminal-style frontend for an AI-assisted (paper-first) trading
backend. React 18 + TypeScript + Vite, Tailwind, `lightweight-charts`,
`lucide-react`, native `fetch` + `WebSocket`.

## Run

```bash
npm install
npm run dev      # opens http://localhost:5173
```

The Vite dev server proxies `/api` and `/ws` to the backend on
`http://localhost:8000` (see `vite.config.ts`). Start the backend first; if it
is down the UI degrades gracefully (disconnected banners, empty states) instead
of crashing.

```bash
npm run build    # type-check + production build
npm run preview  # preview the production build
```

## Architecture

```
src/
  api/        typed client (client.ts) + contract types (types.ts)
  components/ shared UI: TopBar, LeftRail, Layout, CandleChart, KillSwitch, ui.tsx …
  hooks/      usePolling, useWebSocket, useAppData (shared store), useSymbol
  lib/        format.ts — money/pct/color-by-sign formatters
  views/      one file per view (Dashboard, Tickers, OptionsFlow, …)
```

- **`useAppData`** centralizes polling of account / positions / clock /
  watchlist / health (5–30s) plus the WS quote stream, exposed app-wide.
- **`useWebSocket`** reconnects with exponential backoff and exposes latest
  quotes by symbol.
- **Open risk** on the dashboard = Σ (current − stop) × qty across positions.

## Principle

**"LLM proposes, code disposes."** The AI generates theses, signals and
conviction; deterministic rules + risk limits gate every action. Paper mode is
the default and the LIVE indicator is read-only.

## Views

Dashboard · Tickers · Options Flow · Strategies · Research · News ·
Positions & Orders · Settings · Help — all wired to the backend contract under
`/api`.
