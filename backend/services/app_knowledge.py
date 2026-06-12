"""Curated app-knowledge docs + idempotent seeder.

These docs describe THIS application so the chat assistant can answer "about the
app" questions accurately. Content is derived from the actual code/routes (risk
engine rules from services/risk.py, providers from config.py, tables from db.py,
views from frontend/src/views, bot/options action config from models.py + db.py).

``seed_app_knowledge`` upserts every doc by topic on startup, so editing a doc
here and restarting refreshes the stored row (no duplicates).
"""
from __future__ import annotations

from typing import Any

import db
from config import logger

# Each doc: topic (unique key), title, body (markdown), tags.
DOCS: list[dict[str, Any]] = [
    {
        "topic": "overview",
        "title": "What this app is",
        "tags": ["app", "overview", "trading", "terminal", "ai"],
        "body": (
            "# AI Trading Terminal\n\n"
            "A Bloomberg-terminal-style AI trading app for **Alpaca paper trading** with "
            "AI research and a deterministic risk engine. It is **paper-first** — all "
            "broker activity runs against Alpaca's paper environment.\n\n"
            "Core principles:\n"
            "- **NO MOCK DATA.** Market data, news, account, and orders come from the real "
            "Alpaca API; research comes from real LLMs. On failure the app raises or skips "
            "— it never fabricates data.\n"
            "- **The LLM proposes; deterministic code disposes.** Every order passes the "
            "risk engine before it can reach the broker.\n"
            "- **Free 24/7 + premium on-demand.** A background worker uses local Gemma "
            "(free) continuously; on-demand research can use Kimi (cloud) for quality."
        ),
    },
    {
        "topic": "providers",
        "title": "AI providers: Kimi, Gemma, Alpaca",
        "tags": ["providers", "kimi", "gemma", "ollama", "alpaca", "llm", "models"],
        "body": (
            "## Providers\n\n"
            "- **Kimi (Moonshot, cloud)** — `kimi-k2.5`. The **primary on-demand** research "
            "provider for user-initiated analysis (quality). Costs cloud credits, so it is "
            "NOT used by the background worker.\n"
            "- **Gemma (local via Ollama)** — `gemma4:e2b`, base URL `http://localhost:11434`. "
            "The **free** model. Powers the **24/7 background research worker**, the **chat** "
            "(text-to-SQL + app answers), and is the **backup** for on-demand research. "
            "'gemma' is a user-facing alias for the local 'ollama' provider.\n"
            "- **Alpaca (paper)** — real market data, news, bars, snapshots, account, "
            "positions, and order routing. Paper trading is enabled.\n\n"
            "On-demand research order is Kimi → Gemma (fallback). The worker is forced to a "
            "single provider (default Gemma) so it never spends Kimi credits."
        ),
    },
    {
        "topic": "data_model",
        "title": "Database tables (data model)",
        "tags": ["database", "tables", "schema", "mysql", "data model"],
        "body": (
            "## Data model (MySQL `trading_terminal`)\n\n"
            "- **trades** — orders placed (manual/strategy/AI), with status, fills, side, qty, "
            "prices, source, strategy_id.\n"
            "- **research_analyses** — structured per-symbol analysis: thesis, sentiment_score, "
            "conviction, key_risks, suggested_action/stop/target, regime, bear_case, provider, "
            "model.\n"
            "- **deep_research** — long markdown docs. `kind` is one of `analysis`, `deep`, "
            "`earnings`, `market`. Earnings docs are honest news-based syntheses (NOT verbatim "
            "transcripts).\n"
            "- **signals** — strategy rule evaluations (fired flag, matched rules, snapshot).\n"
            "- **risk_events** — every risk-engine decision (approved/warned/vetoed) with rules "
            "and computed metrics.\n"
            "- **bots** — weekly-options bots (symbols, config, ai_gate, risk, action, mode).\n"
            "- **strategies** — rule-based strategies (rules, ai_gate, exits, sizing, action, mode).\n"
            "- **watchlist** — tracked symbols.\n"
            "- **briefings** — market briefings.\n"
            "- **app_knowledge** — these app docs (topic, title, body, tags).\n"
            "- **chat_messages** — chat history.\n"
            "- **settings** — JSON config (risk_limits, research_worker).\n\n"
            "The chat can run read-only SELECTs over: trades, research_analyses, deep_research, "
            "signals, risk_events, bots, strategies, watchlist, app_knowledge."
        ),
    },
    {
        "topic": "risk_engine",
        "title": "The risk engine",
        "tags": ["risk", "engine", "limits", "veto", "kill switch", "circuit breaker"],
        "body": (
            "## Risk engine\n\n"
            "A **deterministic** gate (pure functions in `services/risk.py`). Every order — "
            "manual, strategy, or AI — runs through `evaluate_order` before reaching the broker. "
            "It returns `approved`/`warned`/`vetoed` with the rules that fired. A **veto blocks** "
            "the order; a **warning** lets it through but is recorded. All decisions are logged "
            "to `risk_events`.\n\n"
            "**Veto rules** (defaults; configurable, persisted under settings `risk_limits`):\n"
            "- **kill_switch** — master off-switch; blocks all new orders when engaged.\n"
            "- **circuit_breaker** — blocks new BUY entries when daily P/L breaches "
            "`max_daily_loss_pct` (default 5%).\n"
            "- **max_position_pct** — single position size vs equity (default 20%).\n"
            "- **max_open_positions** — cap on distinct open symbols (default 10).\n"
            "- **max_per_trade_risk_pct** — risk per trade (default 1%); for equities uses "
            "(entry-stop)×qty, for options uses premium at stake.\n"
            "- **max_concentration_pct** — exposure per symbol incl. existing (default 25%).\n"
            "- **buying_power** — order value must not exceed buying power.\n"
            "- **min_price** — minimum share price (default $1); does NOT apply to option premiums.\n\n"
            "**Warnings only:** PDT day-trade count ≥ 3 (informational; PDT no longer enforced), "
            "and market-closed non-GTC orders.\n\n"
            "Options use a **100× contract multiplier**; for options, exposure/open-count is "
            "tracked by the **underlying root** (e.g. NVDA), not the OCC contract symbol."
        ),
    },
    {
        "topic": "research_modes",
        "title": "Research modes (quick/standard/deep, earnings)",
        "tags": ["research", "deep", "earnings", "analyze", "depth", "worker"],
        "body": (
            "## Research\n\n"
            "**Structured analysis** (`/api/research/analyze`) returns thesis, sentiment, "
            "conviction, key risks, suggested action/stop/target, regime, and a bear case. "
            "Depth presets:\n"
            "- **quick** — ~40 bars, lean prompt, fast/cheap.\n"
            "- **standard** — ~120 bars + ~5 headlines.\n"
            "- **deep** — ~120 bars + more news + a full markdown `deep_research` doc.\n\n"
            "**Deep dives** and **earnings research** are markdown docs in `deep_research` "
            "(`POST /api/research/deep` with `kind:'deep'|'earnings'`).\n\n"
            "**Earnings research** pulls REAL Alpaca news, scans it for earnings/guidance/results "
            "headlines, adds price action, and asks the LLM for a structured earnings report "
            "(latest-quarter themes, guidance, KPIs, reaction, what to watch). It ALWAYS carries "
            "a provenance line: *synthesized from Alpaca news headlines and price action — NOT a "
            "verbatim earnings-call transcript.* No verified transcript feed is wired; if a real "
            "transcript provider is configured (`TRANSCRIPT_API_KEY`) it is used, otherwise it is "
            "skipped and **no transcript is fabricated**.\n\n"
            "The **background worker** runs 24/7 on local Gemma, accumulating analyses + earnings "
            "docs for MAG7 (TSLA/META/NVDA every cycle at deep priority; AAPL/MSFT/GOOGL/AMZN on "
            "rotation)."
        ),
    },
    {
        "topic": "chat",
        "title": "The chat assistant (text-to-SQL + app Q&A)",
        "tags": ["chat", "sql", "text-to-sql", "vanna", "assistant", "ask"],
        "body": (
            "## Chat\n\n"
            "A Vanna-style assistant powered by local **Gemma**. It classifies each question:\n"
            "- **sql mode** — when the question can be answered from the database, Gemma writes "
            "ONE read-only `SELECT` over the allowed tables. The backend **validates** it "
            "(SELECT-only, single statement, no writes, auto-LIMIT), runs it, and summarizes the "
            "rows in plain English.\n"
            "- **chat mode** — for general/app questions, Gemma answers grounded in live account "
            "context and the most relevant **app_knowledge** docs (keyword-matched).\n\n"
            "Queryable tables: trades, research_analyses, deep_research, signals, risk_events, "
            "bots, strategies, watchlist, app_knowledge. Example: *\"how many earnings docs are "
            "stored per symbol?\"* → SELECT over deep_research; *\"what does the risk engine "
            "do?\"* → grounded app answer."
        ),
    },
    {
        "topic": "builder",
        "title": "Using the Strategy Builder",
        "tags": ["builder", "strategy", "rules", "indicators", "how to"],
        "body": (
            "## Strategy Builder\n\n"
            "Build rule-based strategies on the **Builder** view. A strategy has:\n"
            "- **symbols** and a **timeframe** (e.g. 1Day).\n"
            "- **rules** — indicator/operator/value conditions joined with AND/OR (e.g. RSI < 30).\n"
            "- **ai_gate** — optionally require AI conviction ≥ a threshold (default 60) before a "
            "signal acts.\n"
            "- **exits** — stop (ATR or fixed) and target (R:R or fixed), optional trailing.\n"
            "- **sizing** — risk per trade %, max position %, max positions.\n"
            "- **action** — what to trade when it fires: equity (`asset:'equity'`) or an option "
            "(`asset:'option'` with right/moneyness/expiry).\n"
            "- **mode** — `signal` (alert only), `semi` (one-click confirm), or `auto` (auto-place, "
            "still risk-gated).\n\n"
            "Strategies persist to the `strategies` table; firings are recorded as `signals`."
        ),
    },
    {
        "topic": "bots",
        "title": "Options bots & action config",
        "tags": ["bots", "options", "weekly", "action", "how to", "setup"],
        "body": (
            "## Options bots\n\n"
            "Weekly-options bots (`kind: options_weekly`) trade options on a set of symbols. "
            "To set one up, configure:\n"
            "- **symbols** — e.g. QQQ, SPY, TSLA, META, NVDA.\n"
            "- **config** — `direction` (research|momentum), `side` (auto|call|put), `expiry` "
            "(default nearest_weekly), `strike` (ATM|delta), `target_delta` (default 0.4), "
            "`contracts`, `max_premium`.\n"
            "- **ai_gate** — `enabled` + `min_conviction` (default 60): only act when research "
            "conviction clears the bar.\n"
            "- **action** — the option spec: `right` (auto picks call when bullish / put when "
            "bearish), `moneyness` (ATM/OTM/ITM), `otm_strikes`, `expiry`, or an exact "
            "`contract_symbol` (OCC) to override.\n"
            "- **risk** — `risk_per_trade_pct` (default 1%).\n"
            "- **mode** — signal / semi / auto.\n\n"
            "Every bot order still passes the deterministic risk engine. Bots persist to the "
            "`bots` table; a default 'Weekly Options — Megacap' bot is seeded."
        ),
    },
    {
        "topic": "views",
        "title": "App views (navigation)",
        "tags": ["views", "navigation", "ui", "dashboard", "screens"],
        "body": (
            "## Views\n\n"
            "- **Dashboard** — account, P/L, watchlist breadth, market briefing.\n"
            "- **Tickers** — per-symbol snapshot, bars, indicators.\n"
            "- **Options Flow** — options activity / chains.\n"
            "- **Builder** — create rule-based strategies.\n"
            "- **Strategies** — manage saved strategies and their firings.\n"
            "- **Research** — analyses, deep dives, and earnings research (quick/standard/deep).\n"
            "- **News** — real Alpaca news headlines.\n"
            "- **Positions/Orders** — open positions and live/working orders.\n"
            "- **Trades** — order/trade history.\n"
            "- **Risk** — risk limits, kill switch, and the risk-events log.\n"
            "- **Onboarding** — first-run setup.\n"
            "- **Settings** — providers, worker config, connections.\n"
            "- **Help** — docs and guidance.\n"
            "- **Chat** — ask questions about your data or the app."
        ),
    },
    {
        "topic": "principles",
        "title": "Core principles: NO MOCK, paper-first",
        "tags": ["principles", "no mock", "paper", "honesty", "provenance"],
        "body": (
            "## Principles\n\n"
            "- **NO MOCK DATA** — every figure comes from a real source (Alpaca for market/news/"
            "account, real LLMs for research). On failure the app raises a 503 or skips; it never "
            "invents data.\n"
            "- **Paper-first** — trading runs against Alpaca's paper environment.\n"
            "- **Honest provenance** — LLM-synthesized content is labeled as such. Earnings "
            "research is explicitly marked *NOT a verbatim transcript*; no transcript is "
            "fabricated when none is available.\n"
            "- **Deterministic risk gate** — AI can propose, but a deterministic engine has the "
            "final say on every order.\n"
            "- **Cost discipline** — the 24/7 worker uses free local Gemma; paid Kimi is reserved "
            "for explicit on-demand requests."
        ),
    },
    {
        "topic": "positions_orders",
        "title": "Positions, orders & trades",
        "tags": ["positions", "orders", "trades", "fills", "broker"],
        "body": (
            "## Positions, orders & trades\n\n"
            "Positions and orders are read live from Alpaca (paper). Placed orders are persisted "
            "to the `trades` table with their Alpaca order id, status, fills, side, qty, prices, "
            "and `source` (manual / strategy / ai). The **Trades** view shows history; "
            "**Positions/Orders** shows current open positions and working orders. Order types "
            "supported: market, limit, stop (with optional take-profit / stop-loss)."
        ),
    },
    {
        "topic": "settings_worker",
        "title": "Settings & the background research worker",
        "tags": ["settings", "worker", "config", "interval", "universe"],
        "body": (
            "## Settings & worker\n\n"
            "The background **research worker** loops on an interval (default 900s), analyzing a "
            "universe of symbols and accumulating `research_analyses` + `deep_research` (including "
            "MAG7 earnings docs) plus a market briefing each cycle. Config lives in the `settings` "
            "table under `research_worker`: `enabled`, `provider` (default gemma), `depth`, "
            "`interval_sec`, `universe`. It defaults to free local Gemma so 24/7 runs never spend "
            "Kimi credits; on failure it logs and skips (no Kimi fallback). Risk limits live under "
            "the `risk_limits` settings key."
        ),
    },
]


def seed_app_knowledge() -> int:
    """Idempotently upsert every app-knowledge doc by topic. Returns count seeded."""
    n = 0
    for doc in DOCS:
        try:
            db.upsert_app_knowledge(doc)
            n += 1
        except Exception as exc:
            logger.warning("seed_app_knowledge: failed for %s (%s).", doc.get("topic"), exc)
    logger.info("Seeded/updated %d app_knowledge docs.", n)
    return n
