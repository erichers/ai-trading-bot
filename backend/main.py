"""Bloomberg-terminal-style AI trading backend (FastAPI).

Run: uvicorn main:app --reload --port 8000
"""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware

import db
from config import logger, settings
from models import HealthResponse
from routers import (
    bots,
    chat,
    indicators_router,
    market,
    news,
    options,
    research,
    research_feed,
    risk,
    strategies,
    trading,
    watchlist,
)
from services import alpaca_service
from services import research as research_svc
from services import research_worker
from services.realtime import RealtimeBroadcaster


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: init schema + seed, then launch the background research worker.
    db.init_db()
    try:
        research_worker.start()
    except Exception as exc:  # never block startup
        logger.warning("research worker failed to start (%s).", exc)
    yield
    # Shutdown: cancel the worker task cleanly.
    try:
        await research_worker.shutdown()
    except Exception as exc:
        logger.warning("research worker shutdown error (%s).", exc)


app = FastAPI(title="AI Trading Terminal Backend", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health", response_model=HealthResponse, tags=["health"])
def health():
    kill_switch_engaged = False
    circuit_breaker_tripped = False
    try:
        limits = db.get_risk_limits()
        kill_switch_engaged = bool(limits.get("kill_switch_engaged"))
        acct = alpaca_service.get_account()
        day_pl_pct = float(acct.get("day_pl_pct") or 0.0)
        max_loss = float(limits.get("max_daily_loss_pct") or 0.0)
        circuit_breaker_tripped = bool(day_pl_pct <= -abs(max_loss)) if max_loss else False
    except Exception:  # health must never fail
        pass
    return {
        "status": "ok",
        "alpaca_connected": alpaca_service.alpaca_connected(),
        "anthropic_configured": settings.anthropic_configured,
        "paper": settings.alpaca_paper_trade,
        "market_open": alpaca_service.market_open(),
        "research_provider": settings.research_provider,
        "research_backup_provider": settings.research_backup_provider,
        "research_model": settings.effective_research_model,
        "kimi_configured": settings.kimi_configured,
        "chat_provider": settings.chat_provider,
        "ollama_connected": research_svc.ollama_connected(),
        "kill_switch_engaged": kill_switch_engaged,
        "circuit_breaker_tripped": circuit_breaker_tripped,
    }


# All REST routers under /api
for r in (
    trading.router,
    market.router,
    news.router,
    options.router,
    watchlist.router,
    indicators_router.router,
    strategies.router,
    research.router,
    research_feed.router,
    risk.router,
    bots.router,
    chat.router,
):
    app.include_router(r, prefix="/api")


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await RealtimeBroadcaster().run(ws)


@app.get("/", tags=["health"])
def root():
    return {"service": "AI Trading Terminal Backend", "docs": "/docs", "health": "/api/health"}
