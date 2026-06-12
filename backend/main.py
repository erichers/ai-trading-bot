"""Bloomberg-terminal-style AI trading backend (FastAPI).

Run: uvicorn main:app --reload --port 8000
"""
from __future__ import annotations

from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware

import db
from config import settings
from models import HealthResponse
from routers import (
    indicators_router,
    market,
    news,
    options,
    research,
    strategies,
    trading,
    watchlist,
)
from services import alpaca_service
from services.realtime import RealtimeBroadcaster

app = FastAPI(title="AI Trading Terminal Backend", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _startup() -> None:
    db.init_db()


@app.get("/api/health", response_model=HealthResponse, tags=["health"])
def health():
    return {
        "status": "ok",
        "alpaca_connected": alpaca_service.alpaca_connected(),
        "anthropic_configured": settings.anthropic_configured,
        "paper": settings.alpaca_paper_trade,
        "market_open": alpaca_service.market_open(),
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
):
    app.include_router(r, prefix="/api")


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await RealtimeBroadcaster().run(ws)


@app.get("/", tags=["health"])
def root():
    return {"service": "AI Trading Terminal Backend", "docs": "/docs", "health": "/api/health"}
